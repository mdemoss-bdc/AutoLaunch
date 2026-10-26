# Trade Appraisal Intake

Matthew's feature (2026-10-26). A customer asks what their car is
worth → the rep sends one link → the customer describes the vehicle,
answers 10 condition questions, and uploads photos → the whole packet
lands in the app for the desk to work. **Information intake only:**
no value is ever generated, calculated, or shown to the customer
anywhere. The only number in the system is the desk's own figure,
typed in by hand. (The store works its numbers on KBB.com itself;
there is deliberately no KBB integration, branding, or scraping.)

## The flow

1. **Rep side** — Sidebar → YOUR BUYERS → **Trade Appraisals**. The
   view shows the rep's personal link (generated on first open,
   stored as `user_settings.trade_token`) with a Copy button, then
   the submissions list: customer, vehicle, photo count, a **Fair**
   badge, status (New / Reviewed / Valued), and the desk figure once
   entered. A sidebar badge counts unreviewed (`new`) submissions.
2. **Customer side** — `luna-rebuild/trade.html?t=<token>` (public,
   no sign-in):
   - Name + phone/email (required).
   - VIN — optional but prompted ("helps us value it faster"); the
     decode button fills year/make/model/trim from the free NHTSA
     vPIC API.
   - Mileage — **required**.
   - The 10 condition questions, **verbatim**, each Yes/No with an
     optional note:
     1. Are the tires good?
     2. Does it pass state inspection?
     3. Is there any damage to the vehicle that can't be seen in pictures?
     4. Has the vehicle been smoked in?
     5. Are there any rips, stains or tears in the seats?
     6. Are there any warning lights on?
     7. Is the windshield or any other glass cracked?
     8. To your knowledge is there anything mechanically wrong with the vehicle?
     9. Does the transmission shift correctly?
     10. Are the brakes good or do they need replaced?
   - **Photos: 10–12 total**, with labeled guidance (outside front /
     sides / rear, inside seats / dash, close-ups of any damage) and
     two **required** specific shots: (1) the VIN plate/sticker,
     (2) the dash with the vehicle **started and running**. Submit
     stays disabled until all of it is present. Photos are shrunk
     client-side (max 1600px JPEG) and uploaded to the
     `trade-photos` Storage bucket under `{token}/{submission-id}/`.
   - The Fair-condition disclaimer is shown **before** the form and
     again above the submit button, with a required acknowledgment
     checkbox; the exact text is stored on the submission:
     *"Your trade will be appraised in Fair condition. This estimate
     is based on the answers you provide — if anything is omitted or
     different when we see the vehicle, the trade value can change."*
3. **Submission** — the page calls the `submit_trade_appraisal`
   RPC (the only public write path). The RPC resolves the token to
   the rep, creates a **prospect** (stage `talking`, source
   `manual`, note summarizing the vehicle), and inserts the
   appraisal stamped `condition_grade = 'Fair'`, status `new`,
   linked to that prospect.
4. **Desk work** — "Review packet" opens the detail view: all 10
   answers with notes, the acknowledgment, the photo grid (VIN and
   dash shots labeled), and the desk section: figure ($), internal
   notes, status. Saving a figure flips status to `valued`
   automatically. Opening a packet flips `new` → `reviewed`.

## Data

- `public.trade_appraisals` — see
  `supabase/migrations_draft/trade_appraisals_APPLIED_2026-10-26.sql`
  (applied 2026-10-26, additive). Owner-only RLS (select/update/
  delete); **no insert policy** — the SECURITY DEFINER RPC is the
  only way in, so the token never exposes a table read.
- `public.user_settings.trade_token` — unique where present.
- Bucket `trade-photos` — public read (mirrors `intro-videos`),
  anonymous insert (paths are token + random submission id; photos
  are only ever displayed via URLs recorded on an appraisal row),
  10 MB/file cap. No delete policy in v1.

## Verification (2026-10-26)

Seeded E2E on the reviewer account, **19/19 checks**: anonymous photo
upload + public read; RPC submit lands the row (Fair, `new`, 11
photos, miles); bad token rejected; anonymous table read returns
nothing (RLS); rep sign-in reads the packet and the auto-created
prospect (`talking`/`manual`); desk PATCH saves figure + `valued`.
One real bug was caught and fixed by the E2E: the page's first draft
used storage `upsert: true`, which anonymous RLS denies — uploads
now use unique paths with plain inserts. Reviewer baseline restored
and re-verified afterward (0 settings / 0 prospects / 0 appraisals /
15 inventory). Three 1×1 test JPEGs remain orphaned in the bucket
under an `e2e-…` folder (Storage forbids direct SQL deletes and the
bucket has no delete policy; ~3 KB, unreferenced by any row).

## Ready for Matthew to test

Open the rebuild app → **Trade Appraisals** → Copy link → open it in
a phone browser and submit a packet with his own car.
