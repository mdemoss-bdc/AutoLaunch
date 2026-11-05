-- APPLIED 2026-11-05 (Matthew): per-account opt-in waiving the auto-post
-- color requirement. DealerCenter DWS feeds publish "-" (no) exterior /
-- interior colors, so those lots could never auto-post; Facebook itself
-- does not require colors — the both-colors rule is AutoLaunch's own.
-- Default false: every existing account keeps today's filtering exactly.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS allow_post_without_colors boolean NOT NULL DEFAULT false;

select pg_notify('pgrst', 'reload schema');
