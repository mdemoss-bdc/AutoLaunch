# AutoLaunch webhook — status & the one remaining step

## Status (updated 2026-10-22 night, by Luna)

**Deployed and wired.** What is already done:

- Edge Function `dispatch-scrape` is **deployed and ACTIVE** (v1,
  `verify_jwt` off — it does its own shared-secret check) on project
  Phantom (`tdsipiltwajwhzgjsupx`).
- Function secrets set: `GITHUB_OWNER` (`mdemoss-bdc`), `GITHUB_REPO`
  (`AutoLaunch`), and `WEBHOOK_SECRET` (a random value Luna generated
  and set on **both** sides — the function and the webhook below — so
  they match; it is written down nowhere else, by design).
- A database trigger `dispatch_scrape_on_insert` now fires on every
  `INSERT` into `public.scrape_jobs` and calls the function through
  Supabase's own `supabase_functions.http_request` machinery (the same
  mechanism the dashboard's Database Webhooks use), sending the shared
  secret in the `x-autolaunch-webhook` header.
- Verified live: the function answers requests; until the last secret
  below exists it returns `{"error":"function_not_configured"}` (HTTP
  500) to everything — the honest "not finished" state. Nothing
  dispatches to GitHub yet.
- The root workflow `.github/workflows/scraper.yml` **already accepts
  the `user_id` input** (checked 2026-10-22) — no workflow change is
  needed. The function sends `{ user_id }` from the inserted job row,
  so one user's Refresh scrapes only that user.

## The ONE remaining step (Matthew, ~2 minutes)

The function needs a GitHub token with permission to start Actions
runs. Luna cannot supply it: the token value lives in the Secure Vault
(she never sees it), and the Actions scope can only be toggled by you
in GitHub settings.

1. **Add the Actions permission to the `muse` token:**
   GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **muse** →
   under Repository permissions set **Actions: Read and write** →
   **Update token**.
2. **Paste the token as the function's secret:**
   Supabase Dashboard → project **Phantom** → **Edge Functions** →
   **Secrets** → **Add secret**: name `GITHUB_PAT`, value = the `muse`
   token value → **Save**.

That's all. No other setup is left.

## Verify together after that step (2 minutes, with Luna)

1. In AutoLaunch, click **Refresh / Sync**. A `scrape_jobs` row is
   inserted → the trigger fires → the function dispatches.
2. GitHub → **Actions** → a fresh **AutoLaunch Scraper Runner** run
   should appear within ~10 seconds, and the inventory updates when
   it finishes.
3. If it doesn't: Supabase Dashboard → **Edge Functions** →
   `dispatch-scrape` → **Logs** shows the function's answer
   (`unauthorized` = secret mismatch; `github_dispatch_failed` with a
   status = GitHub rejected the token — usually the Actions
   permission from step 1).

## ⚠ One cleanup to decide after the proof works

Your database already has an **older** trigger from the original
build — `on_scrape_job_inserted` → `trigger_github_scraper_runner()` —
which dispatches the same workflow directly from Postgres with a
token embedded in the database (its calls succeeded on 2026-10-21,
HTTP 204 from GitHub). Luna left it untouched tonight because it's
your pre-existing plumbing.

Once the Edge Function path above is proven, that old trigger should
be retired — otherwise one Refresh would start **two** scrape runs.
Retiring it is one statement, run on your say-so:

```sql
drop trigger on_scrape_job_inserted on public.scrape_jobs;
-- (the function public.trigger_github_scraper_runner() can stay;
--  with no trigger using it, it is inert.)
```

## How it works (reference)

```
App (Sync button) ──insert──▶ scrape_jobs ──trigger──▶ dispatch-scrape
                                                          │ checks
                                                          │ x-autolaunch-webhook
                                                          ▼
                                              GitHub Actions dispatch
                                              scraper.yml { user_id }
```

End users never see any of this: no tokens, no keys — they sign in
and click Sync. All secrets are the platform owner's, server-side
only, exactly as decided 2026-10-22.
