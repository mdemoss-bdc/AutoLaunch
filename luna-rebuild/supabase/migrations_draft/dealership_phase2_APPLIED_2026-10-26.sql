-- Dealership accounts — Phase 2 (APPLIED to Phantom 2026-10-26 by Luna).
-- Additive columns for the working dealership trial + dealer checkout:
-- plan_flavor ('post'|'group', NULL until paid), trial window, and the
-- dealership's own Stripe linkage (the subscription lives on the
-- dealership, not on any member's user_settings).
ALTER TABLE public.dealership_accounts
  ADD COLUMN IF NOT EXISTS plan_flavor text,
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS billing_status text;

-- Phase 1.5 'pending' dealerships become working 5-day trials
-- (2 member seats, full Group flavor). This migrated Matthew's
-- Test Motors fixture (kept, in trial, by design).
UPDATE public.dealership_accounts
SET status = 'trial',
    seat_limit = 2,
    trial_ends_at = now() + interval '5 days',
    billing_status = 'trialing'
WHERE status = 'pending';

NOTIFY pgrst, 'reload schema';
