-- Founding Lifetime offers + Support Plan (built 2026-10-26, rebuild).
-- Matthew's decided terms (see TIERS.md "Founding Lifetime + Support
-- Plan"): solo Founding Lifetime — Post $1,499 / Group $1,999 one-time,
-- capped at 50 buyers total, priority support included for 1 year,
-- then an optional $199/year Support Plan subscription. Dealerships
-- get NO lifetime offer.
--
-- Applied to Phantom (tdsipiltwajwhzgjsupx) 2026-10-26 via the
-- Management API. Additive only — all four columns are nullable and no
-- existing row changes meaning:
--   lifetime_tier          'post' | 'group' once a lifetime purchase
--                          completes (billing-webhook writes it). A
--                          lifetime account is billing_status 'active'
--                          with current_period_end NULL, forever.
--   lifetime_purchased_at  when the lifetime checkout completed; the
--                          1-year included-support window runs from it.
--   support_plan_status    the Support Plan subscription's status,
--                          written ONLY by support-kind webhook
--                          events — never read by the access machine.
--   support_period_end     the Support Plan's current period end.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS lifetime_tier text,
  ADD COLUMN IF NOT EXISTS lifetime_purchased_at timestamptz,
  ADD COLUMN IF NOT EXISTS support_plan_status text,
  ADD COLUMN IF NOT EXISTS support_period_end timestamptz;

NOTIFY pgrst, 'reload schema';
