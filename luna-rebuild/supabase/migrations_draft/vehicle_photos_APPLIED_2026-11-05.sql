-- =====================================================================
-- APPLIED 2026-11-05 via Management API (additive). Supports the
-- Add Photos feature (Matthew, 2026-11-05): a vehicle the dealer's
-- site shows with NO photos gets an "Add photos" button in the app;
-- the rep shoots photos (mobile camera flow) or picks from the
-- gallery, the app shrinks them in-browser (canvas, max 1600px) and
-- uploads them here. The public URLs land on the car's
-- scraped_inventory.custom_photo_urls (the column every consumer —
-- app guard, auto-post health, extension claim check + poster,
-- listing copy — already counts). The scraper preserves them
-- across syncs while the dealer site shows no real photos and
-- retires them when the dealer publishes its own (the manual-price
-- precedence pattern). One bucket for all users; paths are scoped
-- per user: <user_id>/<vin>/<file>.jpg.
-- =====================================================================

-- Storage bucket (public read; per-user folders like `branding`
-- and `intro-videos`; 10 MB cap mirrors trade-photos — the app
-- downscales before upload, so real files land far under it)
insert into storage.buckets (id, name, public, file_size_limit)
values ('vehicle-photos', 'vehicle-photos', true, 10485760)
on conflict (id) do nothing;

create policy "vehicle_photos_read_all" on storage.objects
  for select using (bucket_id = 'vehicle-photos');
create policy "vehicle_photos_insert_own" on storage.objects
  for insert with check (bucket_id = 'vehicle-photos'
    and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "vehicle_photos_update_own" on storage.objects
  for update using (bucket_id = 'vehicle-photos'
    and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "vehicle_photos_delete_own" on storage.objects
  for delete using (bucket_id = 'vehicle-photos'
    and (storage.foldername(name))[1] = (auth.uid())::text);
