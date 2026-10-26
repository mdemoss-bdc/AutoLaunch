-- =====================================================================
-- APPLIED 2026-10-26 via Supabase Management API (project Phantom),
-- additive only, as part of the overnight rebuild pass (Trade
-- Appraisal intake — Matthew's feature; REVISED spec: information
-- intake only, no valuation automation, no KBB).
--
-- What landed:
--   1. public.trade_appraisals — one row per customer submission.
--      condition_grade is always 'Fair' in v1 (stamped by the RPC).
--      desk_value / desk_notes are the desk's own figure, typed in
--      by hand in the app — nothing anywhere generates a number.
--   2. Owner-only RLS (select / update / delete). There is NO insert
--      policy: public submissions arrive only through the RPC below.
--   3. public.user_settings.trade_token — the rep's share-link token
--      (unique where present). The app generates it on first use of
--      the Trade Appraisals view.
--   4. public.submit_trade_appraisal(token, payload) — SECURITY
--      DEFINER RPC, execute granted to anon + authenticated. Resolves
--      the token to the rep, creates the linked prospect (stage
--      'talking', source 'manual'), inserts the appraisal with
--      prospect_id set, returns {ok, id}. This follows the codebase's
--      owner-only-RLS convention (customer_wishlist has no public
--      path at all; tiktok_connections writes are service-role only) —
--      the token never exposes a table read.
--   5. Storage bucket 'trade-photos' (public read, 10 MB/file) with
--      policies: select for everyone (public bucket, mirrors
--      intro-videos), insert for anyone (the customer is anonymous;
--      uploads land under {token}/{submission-id}/ paths and are only
--      ever displayed via URLs recorded on an appraisal row).
--   Followed by: notify pgrst, 'reload schema'.
-- =====================================================================

create table if not exists public.trade_appraisals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prospect_id uuid references public.prospects (id) on delete set null,
  customer_name text not null default '',
  customer_contact text,
  year int, make text, model text, trim text,
  miles int,
  vin text,
  answers jsonb not null default '{}'::jsonb,
  photos jsonb not null default '[]'::jsonb,
  condition_grade text not null default 'Fair',
  desk_value numeric,
  desk_notes text,
  status text not null default 'new' check (status in ('new','reviewed','valued')),
  created_at timestamptz not null default now()
);
create index if not exists trade_appraisals_user_idx
  on public.trade_appraisals (user_id, created_at desc);

alter table public.trade_appraisals enable row level security;
create policy "trade_select_own" on public.trade_appraisals
  for select using (auth.uid() = user_id);
create policy "trade_update_own" on public.trade_appraisals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trade_delete_own" on public.trade_appraisals
  for delete using (auth.uid() = user_id);

alter table public.user_settings add column if not exists trade_token text;
create unique index if not exists user_settings_trade_token_idx
  on public.user_settings (trade_token) where trade_token is not null;

-- (RPC body as applied — see the live definition; it validates the
-- token, creates the prospect, and inserts the appraisal stamped
-- condition_grade = 'Fair'.)
-- create or replace function public.submit_trade_appraisal(p_token text, p_payload jsonb)
--   returns jsonb language plpgsql security definer set search_path = public ...
-- revoke all on function public.submit_trade_appraisal(text, jsonb) from public;
-- grant execute on function public.submit_trade_appraisal(text, jsonb) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('trade-photos', 'trade-photos', true, 10485760)
on conflict (id) do nothing;
create policy "trade_photos_read_all" on storage.objects
  for select using (bucket_id = 'trade-photos');
create policy "trade_photos_insert_public" on storage.objects
  for insert with check (bucket_id = 'trade-photos');

-- After applying, run: notify pgrst, 'reload schema';
