// =====================================================================
// trial-source-claim — SOLO TRIALS OPEN (2026-11-16, Matthew's call:
// "leave the solo trials open, for everyone").
//
// HISTORY: through 2026-11-16 this function enforced one free trial
// per dealership SOURCE — a solo trialing account that synced an
// inventory source already claimed by another account was stopped
// (billing_status -> 'trial_blocked', reason 'dealership_trial_used').
// Matthew retired that rule so a mass invite to his own organization
// (every rep trialing against the same store inventory) works: any
// number of solo accounts may now trial against the same dealership
// source. The per-account claims in trial-start (IP / extension /
// email) are unchanged and still apply.
//
// CURRENT BEHAVIOR: the app still calls this function at setup save,
// Settings save, and Sync (fail-open on any error). For any
// authenticated caller it now answers success without reading or
// writing trial_dealer_claims and without touching billing state.
// The table is left in place, empty of new writes; accounts blocked
// under the old rule keep their stored state (none exist).
//
// RESTORE: redeploy the previous source from git history (the
// 2026-10-30 build) — no app change is needed either way, because
// the app only reacts to a "blocked" status this build never sends.
//
// verify_jwt=false at the platform level; the caller's JWT is
// verified manually (same pattern as trial-start).
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Verify the caller's JWT against the Auth API; returns the user
// object or null (same helper as trial-start).
async function verifyUser(req: Request): Promise<any | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supabaseUrl || !anon || !token) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "apikey": anon, "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return typeof user?.id === "string" ? user : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  // Solo trials are open (2026-11-16): no source is claimed and no
  // account is ever blocked here. The response shape matches the
  // old success contract so the app proceeds exactly as before.
  return json({ ok: true, status: "ok", claimed: [] });
});
