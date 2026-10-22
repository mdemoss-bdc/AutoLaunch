// =====================================================================
// DRAFT — NOT DEPLOYED. Do not deploy until Matthew has set the secrets
// listed in ../WEBHOOK_SETUP.md. This file lives in the rebuild folder
// for review only; copying it into the live project changes nothing
// until `supabase functions deploy dispatch-scrape` is run by Matthew.
//
// dispatch-scrape — Supabase Edge Function (Deno)
//
// Trigger: Supabase Database Webhook on INSERT into public.scrape_jobs.
// Job:     read the new job's user_id from the webhook payload and call
//          GitHub's workflow_dispatch API for scraper.yml, passing
//          user_id as a workflow input. The scraper then runs exactly
//          as it does on the nightly schedule, for that one user.
//
// Secrets (set by Matthew in the Supabase dashboard — never in code,
// never in the frontend, never seen by end users):
//   GITHUB_PAT            fine-grained token for THIS repo only,
//                         Actions: read/write (workflow dispatch)
//   GITHUB_OWNER          repo owner login (e.g. mdemoss-bdc)
//   GITHUB_REPO           repo name (e.g. AutoLaunch)
//   WEBHOOK_SECRET        shared secret; the Database Webhook sends it
//                         in the x-autolaunch-webhook header and this
//                         function rejects calls without it
// Optional:
//   GITHUB_WORKFLOW_FILE  workflow file name (default "scraper.yml")
//   GITHUB_REF            branch to dispatch on (default "main")
// =====================================================================

interface ScrapeJobRecord {
  id?: string;
  user_id?: string;
  status?: string;
}

interface DatabaseWebhookPayload {
  type?: string; // "INSERT"
  table?: string;
  schema?: string;
  record?: ScrapeJobRecord;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time-ish comparison for the shared secret.
function secretMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("WEBHOOK_SECRET") ?? "";
  const pat = Deno.env.get("GITHUB_PAT") ?? "";
  const owner = Deno.env.get("GITHUB_OWNER") ?? "";
  const repo = Deno.env.get("GITHUB_REPO") ?? "";
  const workflow = Deno.env.get("GITHUB_WORKFLOW_FILE") ?? "scraper.yml";
  const ref = Deno.env.get("GITHUB_REF") ?? "main";

  if (!webhookSecret || !pat || !owner || !repo) {
    // Configuration problem on OUR side — say so plainly in the logs,
    // return 500 so the webhook's failure is visible in the dashboard.
    console.error("dispatch-scrape: missing required secrets");
    return json({ error: "function_not_configured" }, 500);
  }

  if (!secretMatches(req.headers.get("x-autolaunch-webhook"), webhookSecret)) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: DatabaseWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (payload.type !== "INSERT" || payload.table !== "scrape_jobs") {
    // Not ours — acknowledge so Supabase does not retry pointlessly.
    return json({ ignored: true });
  }

  const userId = payload.record?.user_id;
  if (!userId) {
    return json({ error: "missing_user_id" }, 422);
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${pat}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "AutoLaunch-dispatch-scrape",
      },
      body: JSON.stringify({ ref, inputs: { user_id: userId } }),
    },
  );

  if (ghRes.status !== 204) {
    const detail = await ghRes.text();
    console.error(`dispatch-scrape: GitHub dispatch failed ${ghRes.status}: ${detail}`);
    return json({ error: "github_dispatch_failed", status: ghRes.status }, 502);
  }

  console.log(`dispatch-scrape: dispatched ${workflow} for user ${userId} (job ${payload.record?.id ?? "?"})`);
  return json({ dispatched: true, user_id: userId });
});
