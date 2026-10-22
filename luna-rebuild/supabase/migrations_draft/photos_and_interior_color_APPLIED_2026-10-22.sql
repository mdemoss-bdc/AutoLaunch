-- APPLIED 2026-10-22 via Supabase Management API (additive, in-scope DDL).
-- Multi-photo galleries: the scraper now harvests up to 20 VDP gallery URLs
-- per vehicle into scraped_inventory.photos (hero first, width=1600 form);
-- image_url stays = photos[0]. The extension's car fetch is select-*, so
-- photos flows to the posting payload with no app/extension change.
-- interior_color comes from the VDP spec list while the scraper is there.
ALTER TABLE scraped_inventory ADD COLUMN IF NOT EXISTS photos jsonb DEFAULT '[]'::jsonb;
ALTER TABLE scraped_inventory ADD COLUMN IF NOT EXISTS interior_color text;
-- followed by: notify pgrst, 'reload schema';
