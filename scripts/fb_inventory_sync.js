const { createClient } = require('@supabase/supabase-js');

// Support both secret names and standard environment variables
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tdsipiltwajwhzgjsupx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error("Missing Supabase Service Role Key or API Key in environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runAutoPoster() {
  console.log("Starting automated Facebook inventory sync worker...");

  // 1. Fetch all users who enabled auto-posting
  const { data: users, error: userErr } = await supabase
    .from("user_settings")
    .select("*")
    .eq("fb_auto_enabled", true)
    .not("fb_page_id", "is", null)
    .not("fb_access_token", "is", null);

  if (userErr) {
    console.error("Failed fetching user settings:", userErr.message);
    process.exit(1);
  }

  if (!users || !users.length) {
    console.log("No active users found with auto-posting enabled.");
    return;
  }

  for (const user of users) {
    console.log(`\n--- Processing store: ${user.store_name} (${user.user_id}) ---`);

    const allowedConditions = user.fb_auto_conditions || ['Used', 'Certified Pre-Owned'];
    const allowedLocations = user.fb_auto_locations || [];

    // 2. Fetch inventory for this user
    const { data: cars, error: carErr } = await supabase
      .from("scraped_inventory")
      .select("*")
      .eq("user_id", user.user_id)
      .eq("is_active", true);

    if (carErr || !cars || !cars.length) {
      console.log("No active inventory found for user.");
      continue;
    }

    // 3. Filter down to user's selected conditions and locations
    const candidates = cars.filter(car => {
      const matchCond = allowedConditions.includes(car.condition || 'Used');
      const matchLoc = !allowedLocations.length || allowedLocations.includes(car.location_name);
      return matchCond && matchLoc;
    });

    // 4. Fetch list of cars already posted
    const { data: alreadyPosted, error: feedErr } = await supabase
      .from("facebook_ad_feed")
      .select("vin")
      .eq("user_id", user.user_id);

    const postedVins = new Set((alreadyPosted || []).map(p => p.vin));
    
    // Pick unposted vehicles (limit batch to 3 per scheduled run)
    const toPost = candidates.filter(car => !postedVins.has(car.vin)).slice(0, 3);

    console.log(`Found ${candidates.length} matching cars. ${toPost.length} pending auto-post.`);

    for (const car of toPost) {
      await autoPublishCar(user, car);
    }
  }
}

async function autoPublishCar(user, car) {
  const store = car.location_name || user.store_name || "Our Dealership";
  const carTitle = `${car.year || ''} ${car.make || ''} ${car.model || 'Vehicle'} ${car.trim ? car.trim : ''}`;
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

    console.log(`✓ Auto-posted ${car.vin} successfully (Post ID: ${postId})`);
  } catch (err) {
    console.error(`Error auto-posting ${car.vin}:`, err);
  }
}

runAutoPoster();
