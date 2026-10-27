-- Terms acceptance records (built 2026-10-26, rebuild). See TIERS.md
-- "Refund policy". Matthew's rule: ALL sales are final, no refunds,
-- on every plan including Lifetime — and every buyer affirmatively
-- accepts that BEFORE checkout, twice: the in-app purchase-confirm
-- modal (recorded here) and Stripe Checkout's own Terms consent
-- (billing-checkout sets consent_collection.terms_of_service).
-- These rows are the dispute evidence.
--
-- Applied to Phantom (tdsipiltwajwhzgjsupx) 2026-10-26 via the
-- Management API, statements run one at a time, followed by
-- `notify pgrst, 'reload schema'`. Additive only.
--
-- RLS: owner INSERT + SELECT only (auth.uid() = user_id). No UPDATE /
-- DELETE policies — acceptance rows are append-only legal records;
-- deleting a user (e.g. E2E cleanup) cascades their rows away.

CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_key text NOT NULL,
  terms_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terms_acceptances_user_accepted_idx
  ON public.terms_acceptances (user_id, accepted_at);
ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;
CREATE POLICY terms_acceptances_select_own ON public.terms_acceptances
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY terms_acceptances_insert_own ON public.terms_acceptances
  FOR INSERT WITH CHECK (auth.uid() = user_id);
