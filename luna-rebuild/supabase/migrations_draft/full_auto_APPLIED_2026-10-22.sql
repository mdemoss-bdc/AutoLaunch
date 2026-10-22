-- APPLIED 2026-10-22 via Supabase Management API (project tdsipiltwajwhzgjsupx).
-- Additive only; both statements verified in information_schema afterwards,
-- followed by: notify pgrst, 'reload schema';

-- 1) Full Auto posting switch (extension v2.1.4, feature 1):
--    user_settings.full_auto_enabled — read by the extension worker at
--    claim time and carried in the job payload to content.js.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS full_auto_enabled boolean DEFAULT false;

-- 2) Delete jobs (extension v2.1.4, feature 2):
--    auto_posting_queue.action — 'post' (default; every pre-existing row)
--    or 'delete' (a "Remove from Facebook" removal job for the helper).
ALTER TABLE auto_posting_queue ADD COLUMN IF NOT EXISTS action text DEFAULT 'post';

-- 3) Delete-job price context (same build, design follow-on):
--    auto_posting_queue.price — the car's price stamped on the row by
--    whoever creates the delete job, so the helper's strict
--    title+price matcher stays executable even after the car's
--    scraped_inventory row is gone (the delete contract is
--    producer-agnostic: Remove button today, an inventory-lifecycle
--    auto-removal rule later). Type mirrors scraped_inventory.price.
ALTER TABLE auto_posting_queue ADD COLUMN IF NOT EXISTS price integer;
