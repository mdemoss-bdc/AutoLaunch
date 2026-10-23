-- =====================================================================
-- APPLIED 2026-10-22 via Supabase Management API (project Phantom,
-- ref tdsipiltwajwhzgjsupx). This file is the record of what was
-- actually applied to public.customer_wishlist — it replaces the old
-- supabase/wishlist_migration_DRAFT.sql, whose proposed schema never
-- matched the live table. Do not re-run blindly: the statements below
-- are written as executed (create-if-missing + additive alters), and
-- the end-state schema was verified against the live table on
-- 2026-10-22:
--
--   id uuid PK, customer_name text NOT NULL,
--   phone_number text (nullable), desired_vehicle text (nullable),
--   max_price numeric, notes text, is_active bool,
--   created_at timestamptz, dealership_id text, user_id uuid,
--   phone text, email text, make text, model text,
--   year_min int, year_max int, max_miles int
--
--   Row-level security ENABLED, 4 owner-only policies (below).
--
-- History, honestly: the table pre-existed with the legacy columns
-- (phone_number / desired_vehicle were NOT NULL). The app writes the
-- newer columns (phone / email / make / model / year range / caps),
-- so the applied change relaxed the two legacy NOT NULL columns to
-- nullable and added the app columns. Matching lives client-side;
-- nothing about matching is in the database.
-- =====================================================================

-- 1) Base table (legacy shape, as it existed before the app columns).
create table if not exists public.customer_wishlist (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  phone_number text not null,
  desired_vehicle text not null,
  max_price numeric,
  notes text,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  dealership_id text,
  user_id uuid references auth.users (id) on delete cascade
);

comment on table public.customer_wishlist is
  'Customer Wishlist: what each customer is hunting for. Matched client-side against scraped_inventory.';

-- 2) Relax the legacy NOT NULL columns — the app does not collect a
--    phone_number / desired_vehicle pair; it writes phone + the
--    structured want fields below. Inserts failed until this landed.
alter table public.customer_wishlist alter column phone_number drop not null;
alter table public.customer_wishlist alter column desired_vehicle drop not null;

-- 3) App columns (the fields the Wishlist form actually saves).
alter table public.customer_wishlist
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists make text,
  add column if not exists model text,
  add column if not exists year_min int,
  add column if not exists year_max int,
  add column if not exists max_miles int;

comment on column public.customer_wishlist.model is
  'Free-text model/keyword — matched as a substring of make + model + trim.';
comment on column public.customer_wishlist.max_price is
  'Budget cap. NULL means no cap.';
comment on column public.customer_wishlist.max_miles is
  'Mileage cap. NULL means no cap.';

create index if not exists customer_wishlist_user_created_idx
  on public.customer_wishlist (user_id, created_at desc);

-- 4) Owner-only row-level security (4 policies, as verified live).
alter table public.customer_wishlist enable row level security;

drop policy if exists "wishlist_select_own" on public.customer_wishlist;
create policy "wishlist_select_own" on public.customer_wishlist
  for select using (auth.uid() = user_id);

drop policy if exists "wishlist_insert_own" on public.customer_wishlist;
create policy "wishlist_insert_own" on public.customer_wishlist
  for insert with check (auth.uid() = user_id);

drop policy if exists "wishlist_update_own" on public.customer_wishlist;
create policy "wishlist_update_own" on public.customer_wishlist
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "wishlist_delete_own" on public.customer_wishlist;
create policy "wishlist_delete_own" on public.customer_wishlist
  for delete using (auth.uid() = user_id);

-- followed by: notify pgrst, 'reload schema';
