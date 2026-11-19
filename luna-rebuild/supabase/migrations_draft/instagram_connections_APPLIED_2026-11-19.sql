-- =====================================================================
-- APPLIED 2026-11-19 via Management API (additive; the Instagram
-- posting build Matthew approved that evening — see
-- luna-rebuild/INSTAGRAM.md + INSTAGRAM_APP_REVIEW.md). Supersedes
-- instagram_connections_DRAFT.sql (2026-10-26 draft).
--
-- instagram_connections: one row per AutoLaunch user holding their
-- Instagram connection — the IG user id, the linked Facebook Page,
-- the long-lived Meta user access token, and whether Meta has
-- granted the instagram_content_publish permission to the app for
-- this user (publish_permission: granted | pending | unknown — the
-- flow sits dark for publishing until App Review grants Advanced
-- Access). instagram_posts: one row per publish attempt recorded by
-- instagram-post, keyed by the JWT-verified caller — the outcome
-- record for the channel.
--
-- Mirrors tiktok_connections (applied 2026-10-24): tokens live
-- server-side only, never shipped to the browser or logged. The Edge
-- Functions read/write these tables with the service role (which
-- bypasses RLS). Browsers get exactly one ability: SELECT their own
-- rows. There are deliberately NO client INSERT / UPDATE / DELETE
-- policies: only the service role may create, rotate, or remove a
-- connection or an outcome row.
--
-- Additive only: creates two new tables, touches nothing existing.
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
  publish_permission text,
  updated_at timestamptz default now()
);

comment on table public.instagram_connections is
  'Per-user Instagram connection (IG user id, linked Page, long-lived Meta token, publish-permission state). Written only by the instagram-auth / instagram-post Edge Functions via the service role; tokens never leave the server.';

-- Row-level security: owner may read their own row; nothing else is
-- permitted from the client (service role bypasses RLS for writes).
alter table public.instagram_connections enable row level security;

drop policy if exists "instagram_connections_select_own" on public.instagram_connections;
create policy "instagram_connections_select_own" on public.instagram_connections
  for select using (auth.uid() = user_id);

-- No insert / update / delete policies on purpose — see header.

create table if not exists public.instagram_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  vin text,
  stock_number text,
  kind text,
  media_id text,
  container_id text,
  status text,
  error_code text,
  error_message text,
  created_at timestamptz default now()
);

comment on table public.instagram_posts is
  'One row per Instagram publish attempt recorded by instagram-post (published | failed | permission_pending), keyed by the JWT-verified caller. Written only by the service role; owner may read their own rows.';

alter table public.instagram_posts enable row level security;

drop policy if exists "instagram_posts_select_own" on public.instagram_posts;
create policy "instagram_posts_select_own" on public.instagram_posts
  for select using (auth.uid() = user_id);

-- No insert / update / delete policies on purpose — see header.

-- After applying, run: notify pgrst, 'reload schema';
