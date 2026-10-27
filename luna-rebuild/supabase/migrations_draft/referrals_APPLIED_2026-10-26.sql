-- Referral program + solo annual billing (built 2026-10-26, rebuild).
-- Matthew's program (see TIERS.md "Referrals"): every user gets a
-- referral link; when a referred account PAYS, the referrer earns 1
-- free month per 3 paid months of that referral (an annual payment
-- counts 12, earning 4 at once). Caps: bonuses accrue only from a
-- referrer's first 3 bonus-eligible referral accounts, and only
-- during each referral's first 12 paid months (max 4 free months
-- per referral, max 12 per referrer ever). Free months are granted
-- as Stripe customer balance by billing-webhook — never cash.
--
-- Applied to Phantom (tdsipiltwajwhzgjsupx) 2026-10-26 via the
-- Management API, statement by statement. Additive only:
--   referrals          one row per claimed referee (referee unique —
--                      an account can be referred once). Written
--                      ONLY by the referral-claim Edge Function
--                      (service role); RLS lets a referrer SELECT
--                      their own rows for the Plans-tab card.
--                      referee_paid_months / bonuses_granted are the
--                      accrual counters billing-webhook maintains.
--   referral_invoices  webhook idempotency + refund ledger: one row
--                      per processed invoice.paid (invoice_id PK),
--                      recording months/bonus credited and the Stripe
--                      balance transaction, so a redelivered event
--                      never double-counts and a charge.refunded can
--                      reverse exactly what its invoice granted.
--                      RLS on, NO policies — service-role only.
--   user_settings.referral_code
--                      the account's shareable code (UNIQUE, NULL
--                      until generated lazily by referral-claim).
CREATE TABLE IF NOT EXISTS public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL,
  referee_user_id uuid NOT NULL UNIQUE,
  referee_paid_months int NOT NULL DEFAULT 0,
  bonuses_granted int NOT NULL DEFAULT 0,
  bonus_eligible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY referrals_referrer_select ON public.referrals
  FOR SELECT USING (referrer_user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.referral_invoices (
  invoice_id text PRIMARY KEY,
  referral_id uuid NOT NULL REFERENCES public.referrals(id),
  referee_user_id uuid NOT NULL,
  months_added int NOT NULL DEFAULT 0,
  bonuses_delta int NOT NULL DEFAULT 0,
  credit_amount_cents int NOT NULL DEFAULT 0,
  credit_txn_id text,
  revoked_cents int NOT NULL DEFAULT 0,
  refund_status text NOT NULL DEFAULT 'none',
  refund_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;

NOTIFY pgrst, 'reload schema';
