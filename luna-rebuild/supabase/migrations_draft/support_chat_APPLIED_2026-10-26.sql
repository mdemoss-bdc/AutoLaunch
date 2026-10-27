-- Ask Luna support chat (built 2026-10-26, rebuild). See TIERS.md
-- "Luna Support". Two tables backing the support-chat Edge Function:
--
--   support_messages — the per-user chat log (the assistant reads its
--     own history back through it and the daily message cap counts it).
--   support_tickets  — escalations: the manual "Send to support"
--     button AND automatic suspected-defect tickets filed by the
--     assistant (defect governance, Matthew 2026-10-26: defect tickets
--     are Matthew's notification queue — see TIERS.md for the
--     two-lane SAFE / RISK fix rule).
--
-- Applied to Phantom (tdsipiltwajwhzgjsupx) 2026-10-26 via the
-- Management API, statements run one at a time, followed by
-- `notify pgrst, 'reload schema'`. Additive only.
--
-- RLS: enabled on both tables with owner SELECT + INSERT policies
-- only (auth.uid() = user_id). No UPDATE / DELETE policies — rows are
-- append-only for clients; the support-chat function writes through
-- the caller's own JWT, so RLS scopes every read and write to the
-- signed-in user's own rows.

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_user_created_idx
  ON public.support_messages (user_id, created_at);
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_messages_select_own ON public.support_messages
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY support_messages_insert_own ON public.support_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_summary text,
  priority text NOT NULL DEFAULT 'standard'
    CHECK (priority IN ('standard','priority')),
  status text NOT NULL DEFAULT 'open',
  suspected_defect boolean NOT NULL DEFAULT false,
  defect_summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_user_created_idx
  ON public.support_tickets (user_id, created_at);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_select_own ON public.support_tickets
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY support_tickets_insert_own ON public.support_tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
