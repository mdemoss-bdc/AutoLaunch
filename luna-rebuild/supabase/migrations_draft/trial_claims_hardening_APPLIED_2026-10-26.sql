-- Trial-abuse hardening (2026-10-26, APPLIED to Phantom
-- tdsipiltwajwhzgjsupx): two more one-trial claim tables for the
-- trial-start Edge Function (v4), mirroring trial_ip_claims exactly.
--
--   trial_ext_claims   — salted SHA-256 of the helper's per-install id
--                        (helper v2.1.45+ passes ext_install_id when
--                        the user starts a trial from the app).
--   trial_email_claims — salted SHA-256 of the normalized account
--                        email (Gmail: dots and +tags stripped;
--                        Outlook family: +tags only; everything else
--                        exact), so re-spelling the same inbox can't
--                        mint a second trial.
--
-- Both tables: RLS enabled, NO policies — service role only, exactly
-- like trial_ip_claims. Raw ids and raw emails are never stored.

CREATE TABLE IF NOT EXISTS public.trial_ext_claims (
  ext_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trial_ext_claims ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.trial_email_claims (
  email_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trial_email_claims ENABLE ROW LEVEL SECURITY;
