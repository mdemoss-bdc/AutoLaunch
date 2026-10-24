-- =====================================================================
-- APPLIED 2026-10-24 via Management API (additive; Matthew's standing authorization + go-live approval).
--
-- tiktok_connections: one row per AutoLaunch user holding their TikTok
-- (Sandbox, later Production) connection — the TikTok identity plus the
-- OAuth tokens the tiktok-auth / tiktok-post Edge Functions need to
-- post on the user's behalf.
--
-- Tokens live here, server-side only, per the standing webhook-first
-- rule: end users never handle platform keys, and TikTok tokens are
-- never shipped to the browser. The Edge Functions read/write this
-- table with the service role (which bypasses RLS). Browsers get
-- exactly one ability: SELECT their own row (used for debugging /
-- future status reads — the functions above do not rely on it).
-- There are deliberately NO client INSERT / UPDATE / DELETE policies:
-- only the service role may create, rotate, or remove a connection.
--
-- Additive only: creates one new table, touches nothing existing.
-- =====================================================================

create table if not exists public.tiktok_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  open_id text,
  username text,
  display_name text,
  access_token text,
  refresh_token text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scope text,
  updated_at timestamptz default now()
);

comment on table public.tiktok_connections is
  'Per-user TikTok connection (open id, username, OAuth tokens). Written only by the tiktok-auth / tiktok-post Edge Functions via the service role; tokens never leave the server.';

-- Row-level security: owner may read their own row; nothing else is
-- permitted from the client (service role bypasses RLS for writes).
alter table public.tiktok_connections enable row level security;

drop policy if exists "tiktok_connections_select_own" on public.tiktok_connections;
create policy "tiktok_connections_select_own" on public.tiktok_connections
  for select using (auth.uid() = user_id);

-- No insert / update / delete policies on purpose — see header.

-- After applying, run: notify pgrst, 'reload schema';
