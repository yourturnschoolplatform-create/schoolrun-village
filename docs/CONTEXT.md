# YourTurn context

## Purpose

YourTurn is a working-name, mobile-first installable PWA for parents at Victorian schools. It is intended to help **verified parents at the same school** swap school pickup and drop-off trips. The model is non-monetary: it records pair-specific, non-transferable counts of trips owed; it never handles money or cash-value credits.

Day 2 delivered the source foundation for account creation and school verification. Day 3 adds confirmed household links, recurring personal help patterns, four-week dated instances, school term/holiday exclusions, personal Today/calendar views, cancellation records, and confirmed-trip ICS export. Day 4 adds school-scoped reciprocal candidates, two-party swap proposals and acceptance, block-list exclusion, capacity-safe reservations, trust-band-only ranking, and post-acceptance child nickname/year-level reveal. It still does not deliver contact-sharing, safety cases, community, item-board, WhatsApp, payment, trust scoring, or notification workflows.

## Pilot and user boundary

The pilot contains two Victorian schools. Every school owns an independent timezone and configuration. A parent sees one verified school in the interface; the database may retain more than one membership for future migration, but no school switcher is exposed while `school-switcher` is disabled.

Verification is email verification, a school invite code or invitation link, moderator/admin approval, versioned Terms/Privacy/Community Safety consent, and a timestamped self-declaration covering licence, insurance, child restraints, and school pickup rules. There are no document uploads. Child information is limited to a nickname and year level; no other child data is in scope. An unapproved user sees only a generic waiting-for-approval screen. A household link requires both parents to confirm and prevents future same-household swaps.

## Product direction retained for later stages

The product will use a ±15-minute school-configured matching window, strict reciprocity by default, and an optional reciprocal trip on a different date within four weeks. It will include pair-specific trips owed, trust bands, safety departures, opt-in backups, email relay, revocable contact sharing after acceptance, school-scoped community, WhatsApp link-out, free-only giveaway/lending, and scoped volunteer moderation. Safety features are always free. There is no live location tracking.

## Architecture boundary

The frontend is Vite + React + TypeScript + Tailwind. The server is Express + TypeScript. Application data belongs in Supabase Postgres in the Sydney region with Supabase Auth email identity. SQL belongs under `db/migrations`. Every table uses RLS. Ordinary Express data access uses the signed-in visitor’s JWT so RLS remains effective. The Supabase service-role key is confined to a small server-only administrative module for bootstrap, scheduled jobs, and notification sending.

Analytics use event IDs only: `signed_up`, `email_verified`, `school_joined`, `approved`, `child_added`, `declaration_signed`, `invite_sent`, `invite_joined`, `first_listing_created`, `first_match_viewed`, and `first_swap_accepted`. They have no free-form event property payload. Invitation links disclose generic state before approval and no school information. Schedule cancellations are stored as separate immutable trust-engine input events and are not scored until Day 6.

## Start-of-day procedure

Before making any implementation change on a new working day, read the following documents in full:

1. `docs/CONTEXT.md`
2. `docs/DECISIONS.md`
3. `docs/GUARDRAILS.md`
4. `docs/TEST_PLAN.md`

If a proposed change conflicts with them, record and approve an explicit decision update first. Never add secrets to these documents or to any committed file.

## G6 checkpoint status — 2026-11-07

The user confirmed G1–G5 evidence and authorised merging `wip/day4-stabilisation` into the main checkpoint. DEV catalogue evidence through migrations `0001`–`0025` is retained; the DEV live harness was not run because fixture cleanup is not guaranteed. Only narrowly evidenced Day 2/3/4 outcomes may be `[x]`; aggregate day workflows stay `[~]`. See `TODO.md`, `docs/TEST_PLAN.md` and `docs/G6_MERGE_REPORT.md`.

## Day 5 wrap-up — 2026-11-07

Full TEST `npm run verify` exit 0 (47 unit, 252 RLS). Tasks 5.1 / 5.2 backend / 5.3 live scopes are evidenced; aggregate Day 5 remains `[~]` (school notice, email relay transport, 90-day purge, Day 8 reminder delivery).

## Day 6 wrap-up — 2026-11-07

Full TEST `npm run verify` exit 0 (47 unit, 306 RLS, allowlist 97/58/23). Tasks 6.1–6.3 evidenced; running-late notice posting evidenced under Day 7 Task 7.4. Aggregate Day 6 `[x]` at Day 7 wrap. Raw: `docs/evidence/DAY6_WRAPUP_VERIFY_RAW.txt`.

## Day 7 start — 2026-11-07

Authorised by **TASK DAY 7**. Work branch `wip/day7-notices-retention` from Day 6 wrap tip. Baseline `npm run verify` on TEST exit 0 (47 unit, 306 RLS, allowlist 97/58/23). Raw: `docs/evidence/DAY7_START_VERIFY_RAW.txt`. No new migration at start. Scope: school notice, outbound email relay transport, 90-day purge, running-late notices. TEST only; **no Day 8** (handover reminder delivery). See `TODO.md` Tasks 7.1–7.4.

## Day 7 wrap-up — 2026-11-07

Full TEST `npm run verify` exit 0 (47 unit, 376 RLS, allowlist 132/72/44). Tasks 7.1–7.4 evidenced; aggregate Day 7 `[x]`. Raw: `docs/evidence/DAY7_WRAPUP_VERIFY_RAW.txt`. DEV not migrated. **Wait for `GO DAY 8`.**

## Current scope — Day 7

Authorised by **TASK DAY 7**. Work branch `wip/day7-notices-retention`. Closing Day 5/6 residuals that are not reminder delivery. Child data remains nickname + year level only; notices stay phone-free; no amount/price/currency; safety features stay free; no live location.

### Task 7.1 — phone-free school notices and moderation

Migrations `0033`–`0034` add `school_notices` and `school_notice_access_logs` with RLS, phone-free generate/get/list RPCs, school moderator queue and withdraw. Live **6/6** on TEST. Raw: `docs/evidence/TASK_7_1_SCHOOL_NOTICE_LIVE_RAW.txt`.

### Task 7.2 — outbound email relay queue, masking, delivery policy

Migrations `0035`–`0036` add delivery policies, outbound queue, delivery events, masking, service-role claim/complete, and server-admin transport module. Live **6/6** on TEST. Raw: `docs/evidence/TASK_7_2_EMAIL_RELAY_LIVE_RAW.txt`.

### Task 7.3 — 90-day disclosure and access log retention purge

Migrations `0037`–`0038` add `departure_check_logs`, `retention_purge_runs`, service-role `purge_expired_disclosure_retention`, policy reader `get_retention_purge_policy`, and coalesce remediation under `pg_catalog`-only path. Live **5/5** on TEST. Raw: `docs/evidence/TASK_7_3_RETENTION_PURGE_LIVE_RAW.txt`. Allowlist after: `125` public / `69` authenticated / `40` internal.

### Task 7.4 — running-late notices and late trust penalties

Migration `0039` adds `running_late_notices` with RLS, helper-only `post_running_late_notice` before pickup window start, participant get/list, and `post_trust_late_arrival` on `pickup_done` (−2 with prior notice, else −5 at 15+ minutes). Live **6/6** on TEST. Raw: `docs/evidence/TASK_7_4_RUNNING_LATE_LIVE_RAW.txt`. Allowlist after: `132` public / `72` authenticated / `44` internal. Day 8 not started.

### Task 6.1 — score ledger and band projection

Migrations `0027`–`0030` add append-only `trust_score_events`, internal `apply_trust_score_delta` (clamped −100…150, source-idempotent), `get_my_trust` (own score+band), and `get_peer_trust_band` (same-school band only). Peers cannot read numeric scores via RPC, profile select, or event rows.

### Task 6.2 — policy-driven deltas

Migration `0031` posts published-policy deltas from completed legs, schedule/swap cancellations, and eligible urgent cover on accept. Triggers and internal helpers only; clients cannot write scores.

### Task 6.3 — holds, appeals, no-show / false-report

Migration `0032` adds `trust_incident_reports`, `trust_safety_holds`, `trust_appeals`, `trust_trip_penalties` with RLS; moderator resolution; swap-only hold guards on match/propose/accept; provisional 24h and appeal 48h windows. Running-late notice store and late trust wiring landed in Task 7.4.

## Current scope — Task 5.1

The user explicitly authorised the trips-owed ledger only. Migration `0018_day5_trip_count_ledger.sql` adds immutable membership-pair trip entries and a trusted `swap_legs.completed_at` integration marker. The new no-argument `get_my_ledger` RPC returns own-school participant entries and nonnegative pair-netted counts with computed expiry markers. No handover UI/confirmation command, contact consent, school notice, reminder delivery or trust scoring is introduced. Apply and test new SQL on the separate TEST project only. Saving the source checkpoint preserves G6 ancestry and does not apply the new migration to DEV or publish the application.

## Current scope — Task 5.2

The user authorised contact consent next. Migration `0019_day5_contact_consents.sql` adds versioned consents, private-schema mobile storage, selected-backup scope, consent-revoked cancellation events and recipient-only in-app notifications. Three authenticated RPCs grant/revoke/read contact sharing; all take caller identity from auth.uid(), use explicit grants and pg_catalog-only paths. Numbers leave private storage only through the narrow accepted-swap partner/backup getter. A small JWT API and accepted-swap consent form/in-app inbox integrate these functions without displaying numbers in swap summaries. Email relay is default policy but outbound transport is not configured. This task does not implement handover, school notices, email sending or a purge job. New SQL/fixtures target TEST only; source checkpoint saving is not DEV migration/publication.

## Current increment — Task 5.3

Two-step role-bound handover only: provider pickup_done, recipient child_arrived, either order, immutable timestamps/idempotency, completion only after both through application RPCs, atomic Task 5.1 ledger posting and first_trip_completed analytics. Expected arrival defaults to the end of the recipient request window in the school timezone. Exactly one overdue missing confirmation creates a record at expected arrival +30 minutes; delivery is explicitly Day 8. Two new RLS app tables, three caller-scoped RPCs and private trigger/sweep operations use fixed pg_catalog paths and explicit allowlists. Native TEST cron registration and observed execution are evidenced separately; no DEV migration or schedule is authorised by this increment. Save the source checkpoint without publishing. Preserve older G1/C3 failures and Task 5.2's outbound-email/retention limitations; do not implement notices or start another task.
