-- =====================================================================
-- DRAFT — NOT APPLIED. Lives in the rebuild folder for review only.
-- Apply (at Instagram promotion time, after Meta business
-- verification + App Review — see luna-rebuild/INSTAGRAM.md):
--   via Supabase Management API (project Phantom), additive only.
--
-- instagram_connections: one row per AutoLaunch user holding their
-- Instagram connection — the IG user id, the linked Facebook Page,
-- and the long-lived Meta user access token the instagram-auth /
-- instagram-post Edge Functions need to publish on the user's behalf.
--
-- Mirrors tiktok_connections (applied 2026-10-24): tokens live
-- server-side only, never shipped to the browser or logged. The Edge
-- Functions read/write this table with the service role (which
-- bypasses RLS). Browsers get exactly one ability: SELECT their own
-- row. There are deliberately NO client INSERT / UPDATE / DELETE
-- policies: only the service role may create, rotate, or remove a
-- connection.
-- =====================================================================

create table if not exists public.instagram_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ig_user_id text,
  page_id text,
  username text,
  display_name text,
  access_token text,
  token_expires_at timestamptz,
  scope text,
  updated_at timestamptz default now()
);

comment on table public.instagram_connections is
  'Per-user Instagram connection (IG user id, linked Page, long-lived Meta token). Written only by the instagram-auth / instagram-post Edge Functions via the service role; tokens never leave the server. DRAFT — not yet applied.';

-- Row-level security: owner may read their own row; nothing else is
-- permitted from the client (service role bypasses RLS for writes).
alter table public.instagram_connections enable row level security;

drop policy if exists "instagram_connections_select_own" on public.instagram_connections;
create policy "instagram_connections_select_own" on public.instagram_connections
  for select using (auth.uid() = user_id);

-- No insert / update / delete policies on purpose — see header.

-- After applying, run: notify pgrst, 'reload schema';
