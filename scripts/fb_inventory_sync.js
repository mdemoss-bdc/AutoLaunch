const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tdsipiltwajwhzgjsupx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error("Missing Supabase Key in environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DAILY_LIMIT = 25;
const BATCH_SIZE = 3;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runAutoPoster() {
  console.log("=== STARTING FACEBOOK AUTO-POSTER WORKER ===");

  // 1. Fetch user settings
  const { data: users, error: userErr } = await supabase
    .from("user_settings")
    .select("*");

  if (userErr) {
    console.error("Failed fetching user settings:", userErr.message);
    process.exit(1);
  }

  if (!users || !users.length) {
    console.log("No user records found in user_settings table.");
    return;
  }

  console.log(`Found ${users.length} total user record(s).`);

  for (const user of users) {
    console.log(`\n--- Inspecting User: ${user.user_id} (${user.store_name || 'No Name'}) ---`);
    console.log(`Auto Enabled: ${user.fb_auto_enabled}`);
    console.log(`Has Page ID: ${!!user.fb_page_id}`);
    console.log(`Has Access Token: ${!!user.fb_access_token}`);

    if (!user.fb_auto_enabled) {
      console.log("Skipping: fb_auto_enabled is false or not set.");
      continue;
    }
    if (!user.fb_page_id || !user.fb_access_token) {
      console.log("Skipping: fb_page_id or fb_access_token is missing.");
      continue;
    }

    // 2. Check rolling 24-hour post count
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentPosts, error: countErr } = await supabase
      .from("facebook_ad_feed")
      .select("id")
      .eq("user_id", user.user_id)
      .gte("created_at", twentyFourHoursAgo);

    if (countErr) {
      console.error("Error checking recent post count:", countErr.message);
    }

    const postsInLast24h = recentPosts ? recentPosts.length : 0;
    const remainingQuota = Math.max(0, DAILY_LIMIT - postsInLast24h);
    console.log(`Posts in last 24h: ${postsInLast24h}/${DAILY_LIMIT}. Quota remaining: ${remainingQuota}`);

    if (remainingQuota <= 0) {
      console.log("Daily limit reached. Pausing until rolling 24-hour window opens.");
      continue;
    }

    // 3. Fetch active inventory
    const { data: cars, error: carErr } = await supabase
      .from("scraped_inventory")
      .select("*")
      .eq("user_id", user.user_id);

    if (carErr) {
      console.error("Error loading inventory:", carErr.message);
      continue;
    }

    if (!cars || !cars.length) {
      console.log("No inventory found in scraped_inventory for this user_id.");
      continue;
    }

    console.log(`Total inventory records found for user: ${cars.length}`);

    const allowedConditions = (user.fb_auto_conditions && user.fb_auto_conditions.length)
      ? user.fb_auto_conditions
      : ['Used', 'Certified Pre-Owned'];

    const allowedLocations = (user.fb_auto_locations && user.fb_auto_locations.length)
      ? user.fb_auto_locations
      : [];

    console.log("Filter conditions:", allowedConditions);
    console.log("Filter locations:", allowedLocations.length ? allowedLocations : "All Locations Allowed");

    // Filter matching condition and location
    const candidates = cars.filter(car => {
      if (car.is_active === false) return false;
      const cond = car.condition || 'Used';
      const matchCond = allowedConditions.some(c => c.toLowerCase() === cond.toLowerCase());
      const matchLoc = !allowedLocations.length || allowedLocations.includes(car.location_name);
      return matchCond && matchLoc;
    });

    console.log(`Cars matching condition & location filters: ${candidates.length}`);

    // 4. Exclude vehicles already posted
    const { data: alreadyPosted } = await supabase
      .from("facebook_ad_feed")
      .select("vin")
      .eq("user_id", user.user_id);

    const postedVins = new Set((alreadyPosted || []).map(p => p.vin));
    const unposted = candidates.filter(car => !postedVins.has(car.vin));

    console.log(`Unposted matching cars available: ${unposted.length}`);

    const currentBatchLimit = Math.min(BATCH_SIZE, remainingQuota);
    const toPost = unposted.slice(0, currentBatchLimit);

    console.log(`Posting ${toPost.length} car(s) in this run.`);

    for (let i = 0; i < toPost.length; i++) {
      const car = toPost[i];
      await autoPublishCar(user, car);

      if (i < toPost.length - 1) {
        console.log("Waiting 30 seconds before next post...");
        await sleep(30000);
      }
    }
  }

  console.log("=== WORKER FINISHED ===");
}

async function autoPublishCar(user, car) {
  const store = car.location_name || user.store_name || "Our Dealership";
  const carTitle = `${car.year || ''} ${car.make || ''} ${car.model || 'Vehicle'} ${car.trim ? car.trim : ''}`.trim();
  const priceClean = (car.price && car.price > 0) ? "$" + car.price.toLocaleString() : "Call for Price";
  const milesClean = (car.mileage || 0).toLocaleString();
  const listingUrl = car.detail_url || car.listing_url || "";
  const photoUrl = car.image_url;

  const caption = `🔥 FRESH ARRIVAL: ${carTitle} 🔥\n\n` +
    `📍 Available at: ${store}\n` +
    `💰 Price: ${priceClean}\n` +
    `🛣️ Mileage: ${milesClean} miles\n` +
    `⚙️ Transmission: ${car.transmission || "Automatic"}\n` +
    `🎨 Exterior: ${car.color || "Standard"}\n` +
    `🏷️ Condition: ${car.condition || "Inspected & Certified"}\n` +
    `🆔 VIN: ${car.vin || "Available upon request"}\n\n` +
    `HIGHLIGHTS:\n` +
    `✅ Fully inspected & front-line ready\n` +
    `✅ Clean Title\n` +
    `✅ All trades accepted\n` +
    `✅ Financing available for all credit tiers\n` +
    (listingUrl ? `✅ Full vehicle specs: ${listingUrl}\n\n` : `\n`) +
    `💬 Send a direct message to check availability or schedule a test drive before it sells!`;

  try {
    let endpoint = `https://graph.facebook.com/v26.0/${encodeURIComponent(user.fb_page_id)}`;
    const formData = new FormData();
    formData.append("access_token", user.fb_access_token);

    if (photoUrl) {
      endpoint += "/photos";
      formData.append("url", photoUrl);
      formData.append("caption", caption);
    } else {
      endpoint += "/feed";
      formData.append("message", caption);
    }

    console.log(`Sending API call to Meta for VIN ${car.vin}...`);
    const res = await fetch(endpoint, { method: "POST", body: formData });
    const resData = await res.json();

    if (resData.error) {
      console.error(`Meta API Error for VIN ${car.vin}:`, resData.error.message);
      return;
    }

    const postId = resData.post_id || resData.id;

    await supabase.from("facebook_ad_feed").insert({
      user_id: user.user_id,
      vin: car.vin,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim,
      price: car.price,
      mileage: car.mileage,
      image_url: photoUrl,
      detail_url: listingUrl,
      fb_post_id: postId,
      status: 'published'
    });

    console.log(`✓ Auto-posted ${carTitle} (${car.vin}) successfully! Post ID: ${postId}`);
  } catch (err) {
    console.error(`Error auto-posting ${car.vin}:`, err);
  }
}

runAutoPoster();
