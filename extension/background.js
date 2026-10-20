const SUPABASE_URL = "https://tdsipiltwajwhzgjsupx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w";

let isPolling = false;

async function checkQueue() {
  if (isPolling) return;
  isPolling = true;

  try {
    const data = await chrome.storage.local.get(["autolaunch_user_id"]);
    const userId = data.autolaunch_user_id;
    if (!userId) {
      isPolling = false;
      return;
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/auto_posting_queue?user_id=eq.${userId}&status=eq.pending&order=created_at.asc&limit=1`, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      }
    });

    const queueItems = await res.json();
    if (!queueItems || !queueItems.length) {
      isPolling = false;
      return;
    }

    const activeItem = queueItems[0];

    const carRes = await fetch(`${SUPABASE_URL}/rest/v1/scraped_inventory?vin=eq.${activeItem.vin}&user_id=eq.${userId}&limit=1`, {
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      }
    });

    const cars = await carRes.json();
    if (!cars || !cars.length) {
      isPolling = false;
      return;
    }

    const targetCar = cars[0];

    await fetch(`${SUPABASE_URL}/rest/v1/auto_posting_queue?id=eq.${activeItem.id}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({ status: "processing" })
    });

    await chrome.storage.local.set({
      current_posting_job: {
        queueId: activeItem.id,
        car: targetCar
      }
    });

    chrome.tabs.create({ url: "https://www.facebook.com/marketplace/create/vehicle" });

  } catch (err) {
    console.error("Queue check error:", err);
  } finally {
    isPolling = false;
  }
}

setInterval(checkQueue, 20000);

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SET_USER_ID") {
    chrome.storage.local.set({ autolaunch_user_id: message.userId }, () => {
      sendResponse({ status: "connected" });
      checkQueue();
    });
    return true;
  }
});
