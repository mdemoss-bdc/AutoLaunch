-- APPLIED 2026-10-22 by Luna via Supabase Management API (Matthew granted SQL access).
-- The rebuild's settings modals (Auto-Post, Auto-Repost, Photo Edits, Posting Safety,
-- Posting Preferences, Syndication Channels, main Settings save) read/write these
-- user_settings columns, which did not exist in the live schema — every save failed
-- with "Could not find the '<col>' column of 'user_settings' in the schema cache".
-- Purely additive: no existing columns or data touched. PostgREST schema reload notified.
-- Note: legacy columns auto_repost_days / max_daily_posts are the pre-rebuild names for
-- repost_frequency_days / daily_post_limit. The rebuild uses the new names everywhere;
-- reconcile (drop the legacy pair) only when the rebuild is promoted to production.

alter table public.user_settings
  add column if not exists auto_post_enabled boolean default false,
  add column if not exists auto_post_mode text default 'all',
  add column if not exists auto_post_min_photos integer default 1,
  add column if not exists repost_frequency_days integer default 3,
  add column if not exists ai_background_mode text,
  add column if not exists auto_crop_enabled boolean default false,
  add column if not exists photo_crop_position text,
  add column if not exists auto_crop_frequency text,
  add column if not exists daily_post_limit integer default 10,
  add column if not exists posting_speed text,
  add column if not exists vehicle_type text,
  add column if not exists pref_emoji text,
  add column if not exists pref_distance text,
  add column if not exists pref_length text,
  add column if not exists ai_desc_enabled boolean default false,
  add column if not exists ai_prompt_custom text,
  add column if not exists include_clean_title boolean default false,
  add column if not exists include_new_used boolean default false,
  add column if not exists include_mileage_title boolean default false,
  add column if not exists include_vin boolean default false,
  add column if not exists include_stock boolean default false,
  add column if not exists dealership_name text,
  add column if not exists channel_facebook_page_enabled boolean default false,
  add column if not exists channel_instagram_enabled boolean default false,
  add column if not exists channel_tiktok_enabled boolean default false;

notify pgrst, 'reload schema';
