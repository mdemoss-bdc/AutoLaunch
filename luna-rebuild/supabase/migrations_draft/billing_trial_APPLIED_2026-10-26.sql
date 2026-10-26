-- =====================================================================
-- Billing + 5-day trial — APPLIED to Phantom (tdsipiltwajwhzgjsupx)
-- on 2026-10-26 via the Management API (custom.supabase helper).
--
-- Matthew's spec (2026-10-26): new accounts get a 5-day free trial,
-- IP-locked to one trial per IP; during the trial they may pull
-- inventory and queue 1 car per day; after that they must buy
-- (Post $75/mo or Group $100/mo). See TIERS.md "Trial + Billing".
--
-- All changes are additive. trial_started_at / trial_ends_at already
-- existed (legacy columns from the app's earlier trial notion, values
-- on the 2 owner rows predate this system and are ignored by it —
-- the new state machine keys off billing_status only).
-- =====================================================================

-- 1) Billing state on user_settings (all nullable, no defaults changed)
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS billing_status text;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

-- 2) One-trial-per-IP claims. ip_hash = SHA-256 hex of (salt + IP);
--    the salt lives only as the TRIAL_IP_SALT function secret.
--    RLS enabled with NO policies: anon/authenticated get nothing;
--    only the service role (Edge Functions) can read or write it.
CREATE TABLE IF NOT EXISTS public.trial_ip_claims (
  ip_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trial_ip_claims ENABLE ROW LEVEL SECURITY;

-- 3) Grandfathering backfill: every settings row that exists today
--    belongs to an account created before the trial system; mark it
--    'active' so it can never be trial-locked. (2 rows at apply time:
--    Matthew + Jourdan.) New signups get their status from the
--    trial-start Edge Function instead.
UPDATE public.user_settings SET billing_status = 'active' WHERE billing_status IS NULL;

-- 4) Let PostgREST see the new columns
NOTIFY pgrst, 'reload schema';
