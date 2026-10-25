-- =====================================================================
-- APPLIED 2026-10-25 via Supabase Management API (project Phantom).
-- AI Closer + Prospects (spec: AI_CLOSER.md).
-- Additive only: four new tables, owner-only RLS mirroring
-- customer_wishlist / user_intro_videos. Nothing here touches posting.
-- Apply via Supabase Management API (project Phantom) when Phase 1
-- is approved to go live; until then the app runs on localStorage.
-- =====================================================================

-- 1) Prospects — the tiny tracker (NOT a CRM).
create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  city text,
  state text,
  email text,
  notes text,
  -- New -> Talking -> Visit set -> Came in -> Sold / Not now
  stage text not null default 'new'
    check (stage in ('new','talking','visit_set','came_in','sold','not_now')),
  vehicle_id text,
  vehicle_label text,
  source text not null default 'manual'
    check (source in ('manual','marketplace','tiktok','instagram')),
  thread_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospects_user_idx on public.prospects (user_id, stage);

-- 2) Closer profile — the rep's standing instructions + learned style.
create table if not exists public.closer_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mode text not null default 'draft' check (mode in ('off','draft','auto')),
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3) Corrections bank — draft vs what the rep actually sent (learning).
create table if not exists public.closer_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_ref text,
  draft text,
  final text,
  created_at timestamptz not null default now()
);
create index if not exists closer_corrections_user_idx
  on public.closer_corrections (user_id, created_at desc);

-- 4) Message log — every buyer/rep/AI message the closer touches.
create table if not exists public.closer_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  prospect_id uuid references public.prospects (id) on delete set null,
  thread_ref text,
  direction text not null check (direction in ('in','out')),
  origin text not null default 'buyer' check (origin in ('buyer','rep','ai')),
  body text,
  created_at timestamptz not null default now()
);
create index if not exists closer_messages_user_idx
  on public.closer_messages (user_id, thread_ref, created_at);

-- RLS: owner-only on all four tables.
alter table public.prospects enable row level security;
alter table public.closer_profiles enable row level security;
alter table public.closer_corrections enable row level security;
alter table public.closer_messages enable row level security;

do $$
declare t text;
begin
  foreach t in array array['prospects','closer_profiles','closer_corrections','closer_messages']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select using (auth.uid() = user_id)', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert with check (auth.uid() = user_id)', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('create policy %I on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for delete using (auth.uid() = user_id)', t || '_delete_own', t);
  end loop;
end $$;
