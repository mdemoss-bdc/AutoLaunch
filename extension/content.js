(async function() {
  const data = await chrome.storage.local.get(["current_posting_job", "autolaunch_user_id"]);
  if (!data.current_posting_job) return;

  const { queueId, car } = data.current_posting_job;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function setVal(element, text) {
    element.focus();
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  await sleep(4000);

  try {
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
    inputs.forEach(input => {
      const aria = (input.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('price') && car.price) setVal(input, String(car.price));
      if (aria.includes('mileage') && car.mileage) setVal(input, String(car.mileage));
    });

    const textareas = document.querySelectorAll('textarea');
    if (textareas.length > 0) {
      const title = `${car.year || ''} ${car.make || ''} ${car.model || 'Vehicle'} ${car.trim || ''}`.trim();
      const body = `Clean Title: ${title}\n` +
                   `Price: $${(car.price || 0).toLocaleString()}\n` +
                   `Mileage: ${(car.mileage || 0).toLocaleString()} miles\n` +
                   `Exterior: ${car.color || 'Standard'}\n` +
                   `Transmission: ${car.transmission || 'Automatic'}\n` +
                   `VIN: ${car.vin}\n\n` +
                   `Inspected and frontline ready. Message to set up a test drive!`;
      setVal(textareas[0], body);
    }

    if (car.image_url) {
      try {
        const fileInput = document.querySelector('input[type="file"][accept*="image"]');
        if (fileInput) {
          const response = await fetch(car.image_url);
          const blob = await response.blob();
          const file = new File([blob], `${car.vin}.jpg`, { type: "image/jpeg" });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {
        console.warn("Image attach notice:", e);
      }
    }

    await sleep(2000);

    const SUPABASE_URL = "https://tdsipiltwajwhzgjsupx.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";

    await fetch(`${SUPABASE_URL}/rest/v1/auto_posting_queue?id=eq.${queueId}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status: "completed", executed_at: new Date().toISOString() })
    });

    await fetch(`${SUPABASE_URL}/rest/v1/scraped_inventory?vin=eq.${car.vin}&user_id=eq.${data.autolaunch_user_id}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ marketplace_posted_at: new Date().toISOString() })
    });

    await chrome.storage.local.remove(["current_posting_job"]);
  } catch (err) {
    console.error("AutoLaunch posting error:", err);
  }
})();
