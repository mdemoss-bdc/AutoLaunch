-- =====================================================================
-- DRAFT ONLY — DO NOT RUN without Matthew reviewing it first.
-- AutoLaunch Customer Wishlist (sidebar "Leads" replacement, Matthew's
-- own design — see WISHLIST.md).
--
-- One row per customer "want": who it is, how to reach them, and what
-- they are hunting for. The app matches these rows client-side against
-- loaded inventory; nothing about matching lives in the database.
--
-- This migration is additive and idempotent:
--   * creates public.customer_wishlist if it does not exist
--   * enables row-level security with owner-only policies, so a user
--     can only ever see and change their own wishlist
--
-- Until this is applied, the app automatically falls back to storing
-- the wishlist in the browser (localStorage, per user) and shows a
-- notice in the Wishlist view. No entries are lost either way.
-- =====================================================================

create table if not exists public.customer_wishlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  customer_name text not null,
  phone text,
  email text,
  make text,
  model text,
  year_min int,
  year_max int,
  max_price numeric,
  max_miles int,
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.customer_wishlist is
  'Customer Wishlist: what each customer is hunting for. Matched client-side against scraped_inventory.';
comment on column public.customer_wishlist.model is
  'Free-text model/keyword — matched as a substring of make + model + trim.';
comment on column public.customer_wishlist.max_price is
  'Budget cap. NULL means no cap.';
comment on column public.customer_wishlist.max_miles is
  'Mileage cap. NULL means no cap.';

create index if not exists customer_wishlist_user_created_idx
  on public.customer_wishlist (user_id, created_at desc);

alter table public.customer_wishlist enable row level security;

-- Owner-only access. Drop-then-create keeps this draft safe to re-run.
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
