# Webhook Setup — dispatch-scrape (DRAFT)

Status: **DRAFT — nothing here is live.** The Edge Function in
`functions/dispatch-scrape/index.ts` is written and reviewed, but it does
nothing until Matthew personally does the dashboard steps below. All
secrets are Matthew's (platform owner). End users never see any of this —
that is the whole point of the webhook-first design.

Goal: when the app inserts a `scrape_jobs` row (the Refresh button), a
Supabase Database Webhook calls this function, which starts the GitHub
scraper workflow for just that user. No polling, no user-held keys.

## Step 1 — A GitHub token for dispatching (Matthew, in GitHub)

Create a SECOND fine-grained personal access token (do not reuse the
"muse" token Luna uses for the rebuild folder — different job, different
scope):

1. GitHub → profile picture → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token.
2. Name: `autolaunch-dispatch`. Expiration: 90 days (calendar-remind the
   renewal — dispatch silently stops when it expires).
3. Repository access: Only select repositories → **AutoLaunch**.
4. Repository permissions: **Actions: Read and write** (that is what
   workflow_dispatch requires). Nothing else.
5. Generate and copy it — GitHub shows it once. You will paste it into
   Supabase in Step 3, never into chat or code.

## Step 2 — The workflow must accept a user_id input (already done in the rebuild)

`luna-rebuild/workflows/scraper.yml` already declares the optional
`user_id` workflow_dispatch input and passes it to the scraper. When
that file replaces the live `.github/workflows/scraper.yml` (only on
Matthew's approval, like every phase), dispatch will work. The nightly
scheduled run is unchanged and keeps scraping everyone as a safety net.

## Step 3 — Deploy the function and set its secrets (Matthew, in Supabase)

From a computer with the Supabase CLI, in a checkout of this project:

1. `supabase functions deploy dispatch-scrape` (copy
   `luna-rebuild/supabase/functions/dispatch-scrape/` into the project's
   `supabase/functions/` first).
2. Set the secrets (dashboard: Project → Edge Functions → Secrets, or
   CLI `supabase secrets set NAME=value`):
   - `GITHUB_PAT` — the token from Step 1
   - `GITHUB_OWNER` — your GitHub login
   - `GITHUB_REPO` — `AutoLaunch`
   - `WEBHOOK_SECRET` — invent a long random string; you will need the
     same value again in Step 4. A password manager can generate one.
   - Optional: `GITHUB_WORKFLOW_FILE` (default `scraper.yml`),
     `GITHUB_REF` (default `main`)
3. Note the function's URL:
   `https://<project-ref>.supabase.co/functions/v1/dispatch-scrape`

## Step 4 — The Database Webhook (Matthew, in Supabase)

Dashboard → Database → Webhooks → Create a new hook:

- Name: `dispatch-scrape-on-job`
- Table: `public.scrape_jobs`
- Events: **Insert** only
- Type: HTTP Request, Method: POST
- URL: the function URL from Step 3
- HTTP Headers: add one —
  `x-autolaunch-webhook` = the same `WEBHOOK_SECRET` value from Step 3
- Timeout: default is fine. Save.

## Step 5 — Verify (together, with Luna)

1. In the app (test copy first), click **Refresh Inventory**.
2. Supabase → Database → Webhooks: the hook shows a 200 delivery.
3. GitHub → Actions: a `scraper.yml` run starts within seconds, with the
   user_id input set to your user only.
4. The job row flips to completed and inventory updates.
5. Negative test: Luna can call the function URL without the header —
   it must return 401.

## If it breaks

- Webhook deliveries show 500 `function_not_configured` → a secret is
  missing in Step 3.
- 502 `github_dispatch_failed` → the PAT expired, lost Actions
  permission, or the workflow file name/ref is wrong.
- Nothing in Actions at all → check the webhook is enabled and scoped to
  INSERT on `public.scrape_jobs`.
- Rollback: disable the webhook. The nightly scheduled scrape keeps
  working exactly as before; nothing else depends on this hook yet.
