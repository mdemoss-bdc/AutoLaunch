import { createClient } from '@supabase/supabase-js';

const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_TOKEN;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runSync() {
  console.log('--- Starting Facebook Inventory Sync ---');

  // 1. Fetch user configuration/preferences
  const { data: userSettings, error: settingsError } = await supabase
    .from('user_settings')
    .select('*')
    .limit(1)
    .single();

  if (settingsError || !userSettings) {
    console.error('Could not fetch user settings:', settingsError);
    return;
  }

  if (userSettings.fb_auto_enabled === false) {
    console.log('Auto-posting is currently toggled OFF in user settings. Skipping run.');
    return;
  }

  const allowedConditions = (userSettings.fb_auto_conditions || ['Used', 'Certified Pre-Owned'])
    .map(c => c.toLowerCase());
  const allowedLocations = (userSettings.fb_auto_locations || [])
    .map(l => l.toLowerCase());

  console.log(`Preferences -> Conditions: [${allowedConditions.join(', ')}] | Locations: [${allowedLocations.length ? allowedLocations.join(', ') : 'ALL'}]`);

  // 2. Fetch active inventory
  const { data: currentInventory, error: invError } = await supabase
    .from('scraped_inventory')
    .select('*')
    .eq('is_active', true);

  if (invError || !currentInventory) {
    console.error('Error fetching inventory:', invError);
    return;
  }

  // 3. Fetch tracked Facebook sync records
  const { data: trackedRecords, error: syncError } = await supabase
    .from('inventory_facebook_sync')
    .select('*');

  if (syncError) {
    console.error('Error fetching sync records:', syncError);
    return;
  }

  const trackedMap = new Map((trackedRecords || []).map(r => [r.vin, r]));
  const currentVins = new Set(currentInventory.map(car => car.vin));

  // --- Filter based on user preferences ---
  const eligibleVehicles = currentInventory.filter(car => {
    if (!car.vin || trackedMap.has(car.vin) || !car.image_url) return false;

    // Condition filter (New, Used, Certified, All)
    const carCond = (car.condition || '').toLowerCase();
    const matchesCondition = allowedConditions.includes('all') || allowedConditions.some(cond => carCond.includes(cond));

    // Location filter
    const carLoc = (car.location_name || '').toLowerCase();
    const matchesLocation = allowedLocations.length === 0 || allowedLocations.some(loc => carLoc.includes(loc));

    return matchesCondition && matchesLocation;
  });

  console.log(`Found ${eligibleVehicles.length} units matching user criteria. Publishing up to 3...`);

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

      const fbRes = await fetch(`https://graph.facebook.com/v26.0/${PAGE_ID}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: car.image_url,
          message: caption,
          access_token: PAGE_ACCESS_TOKEN
        })
      });

      const fbData = await fbRes.json();
      const compositePostId = fbData.post_id || (fbData.id ? `${PAGE_ID}_${fbData.id}` : null);

      if (compositePostId && !fbData.error) {
        await supabase.from('inventory_facebook_sync').insert({
          vin: car.vin,
          title: `${car.year} ${car.make} ${car.model}`,
          condition: car.condition,
          fb_post_id: compositePostId,
          status: 'active'
        });
        console.log(`Published ${car.vin} to FB (Post ID: ${compositePostId})`);
      } else {
        console.error(`FB Error for ${car.vin}:`, fbData.error);
      }
    } catch (err) {
      console.error(`Failed to publish ${car.vin}:`, err);
    }
  }

  // --- Mark SOLD Vehicles ---
  const activeTrackedCars = (trackedRecords || []).filter(r => r.status === 'active' && r.fb_post_id);
  const soldCars = activeTrackedCars.filter(car => !currentVins.has(car.vin));

  console.log(`Found ${soldCars.length} sold vehicles to mark.`);

  for (const car of soldCars) {
    try {
      const soldMessage = `🔴 UPDATE: This ${car.title} has been officially SOLD!\n\n` +
        `Looking for a similar vehicle or want early notice on incoming arrivals? Send us a direct message or check out our active inventory.`;

      const commentRes = await fetch(`https://graph.facebook.com/v26.0/${car.fb_post_id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: soldMessage,
          access_token: PAGE_ACCESS_TOKEN
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
          .eq('vin', car.vin);
        console.log(`Marked ${car.vin} as SOLD with comment ${commentData.id}`);
      } else {
        console.error(`Error commenting on ${car.vin}:`, commentData.error);
      }
    } catch (err) {
      console.error(`Failed to post sold comment for ${car.vin}:`, err);
    }
  }

  console.log('--- Sync Completed ---');
}

runSync();
