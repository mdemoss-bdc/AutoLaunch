import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runSync() {
  console.log('--- Starting Multi-User Facebook Inventory Sync ---');

  // 1. Fetch ALL users who have auto-posting enabled and configured
  const { data: allUsers, error: usersError } = await supabase
    .from('user_settings')
    .select('*')
    .eq('fb_auto_enabled', true);

  if (usersError || !allUsers || allUsers.length === 0) {
    console.log('No users found with auto-posting enabled.');
    return;
  }

  console.log(`Processing auto-sync for ${allUsers.length} user(s)...`);

  // Loop over every user independently
  for (const user of allUsers) {
    const uid = user.user_id;
    const pageId = user.fb_page_id || process.env.FB_PAGE_ID;
    const pageToken = user.fb_page_token || process.env.FB_PAGE_TOKEN;

    if (!pageId || !pageToken) {
      console.log(`Skipping user ${uid}: Missing Facebook Page ID or Token.`);
      continue;
    }

    console.log(`\n--- Running sync for User: ${uid} (Page: ${pageId}) ---`);

    const allowedConditions = (user.fb_auto_conditions || ['Used', 'Certified Pre-Owned'])
      .map(c => c.toLowerCase());
    const allowedLocations = (user.fb_auto_locations || [])
      .map(l => l.toLowerCase());

    // 2. Fetch inventory isolated to THIS user
    const { data: currentInventory, error: invError } = await supabase
      .from('scraped_inventory')
      .select('*')
      .eq('user_id', uid)
      .eq('is_active', true);

    if (invError || !currentInventory) {
      console.error(`Error fetching inventory for user ${uid}:`, invError);
      continue;
    }

    // 3. Fetch tracked Facebook posts isolated to THIS user
    const { data: trackedRecords, error: syncError } = await supabase
      .from('inventory_facebook_sync')
      .select('*')
      .eq('user_id', uid);

    if (syncError) {
      console.error(`Error fetching sync records for user ${uid}:`, syncError);
      continue;
    }

    const trackedMap = new Map((trackedRecords || []).map(r => [r.vin, r]));
    const currentVins = new Set(currentInventory.map(car => car.vin));

    // 4. Filter vehicles matching this user's criteria
    const eligibleVehicles = currentInventory.filter(car => {
      if (!car.vin || trackedMap.has(car.vin) || !car.image_url) return false;

      const carCond = (car.condition || '').toLowerCase();
      const matchesCond = allowedConditions.includes('all') || 
        allowedConditions.some(cond => carCond.includes(cond));

      const carLoc = (car.location_name || '').toLowerCase();
      const matchesLoc = allowedLocations.length === 0 || 
        allowedLocations.some(loc => carLoc.includes(loc));

      return matchesCond && matchesLoc;
    });

    console.log(`User ${uid}: Found ${eligibleVehicles.length} eligible units. Publishing up to 3...`);

    // 5. Publish up to 3 units to this user's Facebook Page
    for (const car of eligibleVehicles.slice(0, 3)) {
      try {
        const caption = `🔥 FRESH ARRIVAL: ${car.year} ${car.make} ${car.model} ${car.trim || ''}\n` +
          `📍 Available at: ${car.location_name || 'Moses Auto Group'}\n` +
          `💵 Price: $${Number(car.price || 0).toLocaleString()}\n` +
          `⏱ Mileage: ${Number(car.mileage || 0).toLocaleString()} miles\n` +
          `⚙️ Condition: ${car.condition}\n` +
          `🎨 Color: ${car.color || 'Standard'}\n` +
          `🆔 VIN: ${car.vin}\n\n` +
          `✅ Fully inspected & front-line ready\n` +
          `✅ Clean Title\n` +
          `✅ All trades accepted\n` +
          `🔗 Full vehicle specs: ${car.detail_url || ''}\n\n` +
          `💬 Send a direct message to check availability or schedule a test drive before it sells!`;

        const fbRes = await fetch(`https://graph.facebook.com/v26.0/${pageId}/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: car.image_url,
            message: caption,
            access_token: pageToken
          })
        });

        const fbData = await fbRes.json();
        const compositePostId = fbData.post_id || (fbData.id ? `${pageId}_${fbData.id}` : null);

        if (compositePostId && !fbData.error) {
          await supabase.from('inventory_facebook_sync').insert({
            user_id: uid,
            vin: car.vin,
            title: `${car.year} ${car.make} ${car.model}`,
            condition: car.condition,
            fb_post_id: compositePostId,
            status: 'active'
          });
          console.log(`Published ${car.vin} for user ${uid} (Post ID: ${compositePostId})`);
        } else {
          console.error(`FB Error for user ${uid} (${car.vin}):`, fbData.error);
        }
      } catch (err) {
        console.error(`Publish error for user ${uid} (${car.vin}):`, err);
      }
    }

    // 6. Post "SOLD" comments on vehicles that dropped off THIS user's feed
    const activeTrackedCars = (trackedRecords || []).filter(r => r.status === 'active' && r.fb_post_id);
    const soldCars = activeTrackedCars.filter(car => !currentVins.has(car.vin));

    console.log(`User ${uid}: Found ${soldCars.length} sold vehicles to mark.`);

    for (const car of soldCars) {
      try {
        const soldMessage = `🔴 UPDATE: This ${car.title} has been officially SOLD!\n\n` +
          `Looking for a similar vehicle or want early notice on incoming arrivals? Send us a direct message or check out our active inventory.`;

        const commentRes = await fetch(`https://graph.facebook.com/v26.0/${car.fb_post_id}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: soldMessage,
            access_token: pageToken
          })
        });

        const commentData = await commentRes.json();

        if (commentData.id) {
          await supabase.from('inventory_facebook_sync')
            .update({
              status: 'sold',
              fb_comment_id: commentData.id,
              sold_at: new Date().toISOString()
            })
            .eq('vin', car.vin)
            .eq('user_id', uid);
          console.log(`Marked ${car.vin} as SOLD for user ${uid}`);
        } else {
          console.error(`Comment error for user ${uid} (${car.vin}):`, commentData.error);
        }
      } catch (err) {
        console.error(`Sold comment error for user ${uid} (${car.vin}):`, err);
      }
    }
  }

  console.log('\n--- Multi-User Sync Completed ---');
}

runSync();
