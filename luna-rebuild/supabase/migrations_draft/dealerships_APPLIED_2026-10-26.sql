-- Dealership accounts — Phase 1 (APPLIED 2026-10-26, Phantom)
--
-- Matthew's dealership/seat product: one dealership account whose
-- admin creates and manages member accounts up to a seat limit.
-- Members of an ACTIVE dealership are "covered" — full access
-- through the dealership, never trialed or purchase-gated (their own
-- user_settings.billing_status stays NULL and unused).
--
-- Tables (named dealership_accounts / dealership_account_members —
-- plain "dealerships" is already taken in Phantom by the LEGACY
-- inventory-source table the scraper reads: text id, slug, lot URLs,
-- 33 live rows keyed from scrape_jobs.dealership_id. That table is
-- untouched by this product):
--   dealership_accounts        — the store account: name, who
--                                created it (created_by = the
--                                owner/provisioner), seat_limit
--                                (NULL = unlimited), plan_key
--                                (dealer_10/20/50/100/unlimited),
--                                status ('active' | 'inactive').
--   dealership_account_members — membership: one dealership per
--                                user in Phase 1 (user_id UNIQUE),
--                                role ('admin' | 'member').
--
-- RLS: enabled on both. Clients can SELECT their own membership row,
-- their dealership's row, and their dealership's member list — all
-- reads are scoped through current_user_dealership_ids() (a SECURITY
-- DEFINER helper so the policies never recurse into the table they
-- protect). There are deliberately NO client write policies: every
-- write goes through the dealership-admin Edge Function (service
-- role), which enforces roles and seat limits server-side.

create table if not exists public.dealership_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null,
  seat_limit int null,
  plan_key text null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.dealership_account_members (
  dealership_id uuid not null references public.dealership_accounts(id) on delete cascade,
  user_id uuid not null unique,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (dealership_id, user_id)
);

alter table public.dealership_accounts enable row level security;
alter table public.dealership_account_members enable row level security;

create or replace function public.current_user_dealership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select dealership_id
  from public.dealership_account_members
  where user_id = auth.uid()
$$;

drop policy if exists "members read own membership and roster" on public.dealership_account_members;
create policy "members read own membership and roster"
  on public.dealership_account_members
  for select
  using (
    user_id = auth.uid()
    or dealership_id in (select public.current_user_dealership_ids())
  );

drop policy if exists "members read own dealership" on public.dealership_accounts;
create policy "members read own dealership"
  on public.dealership_accounts
  for select
  using (
    id in (select public.current_user_dealership_ids())
  );

notify pgrst, 'reload schema';
