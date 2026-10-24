-- =====================================================================
-- APPLIED 2026-10-24 via Management API (additive; Matthew approved the
-- multi-video intro build in chat). Supports Settings -> Dealership ->
-- "My Intro Videos": upload multiple, select one, or random-per-post.
-- Fail-open: posting code does not read any of this yet (Phase 1).
-- =====================================================================

-- 1) Storage bucket (public read; per-user folders like `branding`)
insert into storage.buckets (id, name, public, file_size_limit)
values ('intro-videos', 'intro-videos', true, 52428800)
on conflict (id) do nothing;

create policy "intro_videos_read_all" on storage.objects
  for select using (bucket_id = 'intro-videos');
create policy "intro_videos_insert_own" on storage.objects
  for insert with check (bucket_id = 'intro-videos'
    and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "intro_videos_update_own" on storage.objects
  for update using (bucket_id = 'intro-videos'
    and (storage.foldername(name))[1] = (auth.uid())::text);
create policy "intro_videos_delete_own" on storage.objects
  for delete using (bucket_id = 'intro-videos'
    and (storage.foldername(name))[1] = (auth.uid())::text);

-- 2) One row per uploaded intro video
create table if not exists public.user_intro_videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_url text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);
alter table public.user_intro_videos enable row level security;
create policy "intro_videos_select_own" on public.user_intro_videos
  for select using (user_id = auth.uid());
create policy "intro_videos_insert_own_row" on public.user_intro_videos
  for insert with check (user_id = auth.uid());
create policy "intro_videos_update_own_row" on public.user_intro_videos
  for update using (user_id = auth.uid());
create policy "intro_videos_delete_own_row" on public.user_intro_videos
  for delete using (user_id = auth.uid());

-- 3) Selection state on user_settings
alter table public.user_settings
  add column if not exists intro_video_enabled boolean not null default false;
alter table public.user_settings
  add column if not exists intro_video_mode text not null default 'selected';
alter table public.user_settings
  add column if not exists intro_selected_video_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'user_settings_intro_selected_fk') then
    alter table public.user_settings
      add constraint user_settings_intro_selected_fk
      foreign key (intro_selected_video_id)
      references public.user_intro_videos(id) on delete set null;
  end if;
end $$;
