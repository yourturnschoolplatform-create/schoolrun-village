# YourTurn delivery tracker

> Status key: `[ ]` open · `[~]` in progress · `[x]` evidenced complete
>
> **Current authorised scope:** Day 9 started on `wip/day9-listings` (TEST only). Aggregate Day 8 `[x]`. Aggregate Day 7 `[x]`. Aggregate Day 6 `[x]`. Aggregate Day 5 `[x]`. **Do not start Day 10** until **`GO DAY 10`**. Mark `[x]` only with passing live names and raw output.

## [~] Day 1 — project, PWA, policy, and security foundation

Source, static tests, build, and browser regression evidence exist for the Vite/React/Express foundation, PWA shell, protected configuration boundary, audit logs, policy versions, and two-school fixture. G5 applied all `0001`–`0017` migrations to DEV successfully. The DEV catalogue shows every public table has RLS, no anonymous public-function execution and no SECURITY DEFINER function without a fixed search_path. DEV live tests were deliberately not run because the current harness does not clean up committed fixtures. The latest full test-project verify is still failing; do not treat migration success as complete application acceptance.

## [~] Day 2 — sign-up and school verification

The email sign-up, versioned consent, approval state, limited child profile, safety declaration, invitation, moderator workflow, Day 2 migrations, RLS contracts, UI, and tests are implemented in source. Migrations through `0017` are applied to the separate test project and DEV. The connection blocker is resolved. End-to-end signup/verification/code redemption/approval/declaration acceptance and invitation-token requirements are not yet evidenced by passing live tests; G1 currently fails. No secret value is stored here.

### [x] Day 2 — evidenced cross-school privacy and invitation-role boundaries

Passing test-project live names (G4 run; `authenticated`, row_security enabled, synthetic JWT claims):

- `blocks School B parent direct reads of School A school and configuration data`
- `blocks School B parent direct reads of School A child data`
- `allows School B moderator own-school queue scope but blocks School A memberships`
- `blocks School B users and moderators from School A-only safety declaration versions`
- `denies direct analytics writes and invite code/hash queries to browser-authenticated users`
- `denies School B moderator direct membership mutation outside the audited review RPC`
- `C1 creates school invitations only for the intended moderator or admin and school scope`

This completed sub-item does not mark the full Day 2 onboarding journey complete.

## [~] Day 3 — household confirmation and boundaries

- Add an RLS-protected household-link model. One verified parent requests a link and the other verified parent explicitly confirms it; only the two participants can see the relationship state.
- Enforce a no-self-link constraint and add an `is_same_household(user_a, user_b)` helper for future matching. The Day 3 data model must preserve the rule that parents in the same confirmed household cannot swap with one another; do not build matching in this stage.
- Do not store or request a residential address, coordinates, map pin, route, live location, mobile number, or additional child information. Household UI must use neutral participant/status wording only.

### [x] Day 3 — evidenced third-party household privacy and internal-RPC restriction

Passing test-project live name: `does not expose household status to a third party or allow public internal expansion RPCs`. This proves the tested third-party relation lookup returns false and internal expansion execution is denied. Bilateral household creation/claim success remains `[~]`; it is not covered by that test.

## [~] Day 3 — recurring help patterns and four-week expansion

- Create weekly recurring **“I can help”** and **“I need help”** patterns with pickup or drop-off direction, weekday, a local start/end time window, a suburb-level area label, and capacity. Validate the area label as a non-address label and retain no coordinates.
- Expand active patterns into dated local-time instances for the next four weeks in the school timezone. Persist service dates and local times so daylight-saving transitions retain the intended local time.
- Add school-scoped term and holiday calendar periods. Skip holiday dates automatically; when term periods exist, skip dates outside the configured term periods.
- Support editing a whole pattern, cancelling one dated instance, and cancelling a whole pattern. A cancellation writes an immutable schedule-cancellation event for the Day 6 trust engine; it does not calculate a trust score now.
- Record only the IDs-only `first_listing_created` analytics event when a parent creates their first pattern.

## [~] Day 3 — personal Today/calendar views and ICS

- Add an authenticated personal schedule hub with **Today** and **Calendar** views. It shows only the signed-in parent’s pattern/instance data, dates, local time windows, direction, capacity, non-address area label, and cancellation state.
- Provide an ICS download endpoint for confirmed trip instances only. Day 3 does not create matches or confirmations, so an empty confirmed-trip calendar is valid until a later stage supplies confirmed instances.
- Preserve Australian English copy and state clearly that matching remains a later feature stage.

## [~] Day 3 — RLS, timezone, quality gate, and report

- Add RLS for every new table, least-privilege grants, append-only cancellation-event controls, and school-scoped calendar-period access. A School B parent/moderator must not read or modify School A calendar periods, patterns, instances, household state, or cancellation events.
- Add unit tests for four-week expansion, holiday/term skipping, one-instance versus whole-pattern cancellation, ICS escaping/output, and Australia/Melbourne daylight-saving local-time handling.
- Add migration/RLS contract coverage and UI/E2E coverage for creating a pattern, viewing four weeks with a skipped holiday, cancelling one instance, and exporting ICS. `npm run verify` must pass once the isolated test DB connection is available.
- Produce the Day 3 report in the standard format: (a) what works, (b) all tables and RLS status, (c) verify output, (d) known bugs by severity, (e) guardrail risks, and (f) exact click path. Then stop and wait for **`GO DAY 4`**.

### [x] Day 3 — evidenced schedule/calendar cross-school isolation

Passing test-project live names:

- `blocks School B parent and moderator reads of School A calendar, patterns, instances, households and cancellation events`
- `blocks School B parent and moderator mutation attempts against School A Day 3 data`
- `requires a current school-specific declaration rather than accepting an older global declaration`

Only the queries actually asserted by those tests are complete; four-week creation/edit/cancel/ICS end-to-end acceptance remains `[~]`.

**Pre-Task-5.1 evidence:** G4's full `npm run verify` passed TypeScript, ESLint, 27 unit tests, 39 static RLS contract assertions, one RPC smoke test and the allowlist gate (`54` test-project public functions, `38` allowlist entries). It failed 2 of 17 live tests (55/57 RLS tests passed): C3's privileged read-back saw the purported third-party row expired; G1's expired-invitation fixture violated a check constraint. Do not label either a pass or infer function correctness from those failures. G5 applied `0001`–`0017` to DEV; raw catalogue evidence is in `docs/evidence/G5_DEV_DATABASE_EVIDENCE.txt`. G6 explicitly authorised the main merge while retaining these failures. Day-level acceptance remains `[~]` where full live evidence is missing. The current Task 5.1 run is recorded below.

## [~] Day 4 — reciprocal candidates and privacy-preserving ranking

- Match only verified parents in the same school using that school’s configured matching window (default ±15 minutes). A candidate requires both legs: the viewer’s **I need help** instance paired with the other parent’s **I can help** instance, and the other parent’s need paired with the viewer’s help instance.
- Keep strict same-date reciprocity as the default. Permit a viewer to opt in to reciprocal dates within the school-configured four-week window only when the school allows different-date reciprocity. Never create a unilateral trip proposal.
- Rank candidates by time-window overlap, matching coarse area label, and trust **band**. Return/display only `Trusted`, `Standard`, `Caution`, `Restricted`, or `Suspended`; never return or expose exact trust scores.
- Exclude self, confirmed household pairs, either-direction blocks, suspended/unavailable users, expired/cancelled/confirmed instances, and any instance already at capacity or reserved by an active swap.

## [~] Day 4 — proposals, two-party acceptance, reveal, and exclusivity

- Add audited proposal states and transitions: propose, accept, decline, withdraw, and expire. A swap exists only after the recipient accepts; a proposal must never be represented as an accepted swap beforehand.
- Reveal child nickname and year level only to the two participants and only after a swap reaches accepted. Do not expose child rows, exact trust score, contact details, addresses, or payment/amount data in candidate or pending proposal responses.
- Add a school-scoped block list; a block in either direction removes the pair from candidate queries and prevents a new proposal.
- Prevent double-booking with transactional locks and capacity checks over all four reciprocal instances. Simultaneous acceptance/proposal operations must fail safely rather than reserve an already-full or already-needed instance twice.
- Record IDs-only `first_match_viewed` and `first_swap_accepted` events exactly once per actor. No free-form analytics payload is permitted.

### [x] Day 4 — evidenced direct cross-school swap-data isolation

Passing test-project live name: `blocks School B parent and moderator reads and writes of School A proposals, legs and blocks`. The precise assertions are proposal/leg/block SELECT isolation, proposal UPDATE denial and block INSERT denial for both School B roles. This does not prove swap-leg mutation denial, every RPC's school scope, successful acceptance, child reveal or concurrency.

### [x] Day 4 — evidenced analytics attribution assertions

Passing test-project live name: `C4 derives analytics actor and school from auth.uid and denies anon`. The observed assertions are the caller's `email_verified` actor with null school, `first_match_viewed` actor with the caller's School B membership, and denial of anonymous `record_first_match_viewed`. Wider analytics cases and `first_swap_accepted` acceptance remain unproven.

## [~] Day 4 — interface, tests, and report

- Add a mobile matching surface showing candidate name, coarse area label, time overlap, reciprocal date, and trust band; allow propose/block and show the caller’s inbound/outbound/accepted swaps with accept, decline, and withdraw actions.
- Add unit tests for matching eligibility/ranking, strict versus opt-in different-date reciprocity, reveal rules, and concurrent accept/proposal guards. Add static and live RLS tests for all new tables, School B user/moderator isolation, blocked-user exclusion, and non-privileged authenticated execution.
- Seed two synthetic same-school parents for the isolated test project so the acceptance path is: see suggestion → propose → accept → each participant sees the accepted swap/child reveal → blocked pair is absent. `npm run verify` must pass once the isolated test DB credential issue is repaired.
- Produce the Day 4 report in the standard format: (a) what works, (b) every table and RLS status, (c) verify output, (d) known bugs by severity, (e) guardrail risks, and (f) exact click path. Then wait for **`GO DAY 5`**.

### [x] Day 4 — evidenced anonymous privilege and published-policy guards

Passing test-project live names:

- `denies anon execute on every public function and every public table privilege` (catalogue privilege inspection, not individual anonymous execution attempts)
- `leaves published trust policy unchanged after authenticated mutation attempt` (zero rows/error plus privileged unchanged-row read-back)
- `calls every allowlisted RPC without a missing-function or search_path/extension error` (resolution smoke only; authorisation denials allowed, not end-to-end RPC success)

**Outstanding:** C3 and G1 red tests; invitation token and C2 acceptance cases; simultaneous accept race; bilateral block exclusion; accepted-partner-only child reveal; unapproved matching denial; every allowed RPC's cross-school tests. G5 also shows most SECURITY DEFINER functions still use `pg_catalog, public, extensions`, not `pg_catalog` only. No aggregate Day 4 `[x]` is justified by current evidence.

**G4 re-run — 2026-11-06, TEST only, Day 4 remains `[~]`.** Repeated `npm run verify` at 21:21:53 exited **1**. TypeScript, ESLint, and unit **47/47** passed. Allowlist unchanged: 69 public functions, 45 authenticated entries, 8 internal declarations. Full RLS harness at 21:25:11: **249 pass / 3 fail (252)**. Failures: legacy C3 read-back (`...011` and `...012` observed `expired`), legacy G1 `school_invitations_check` (23514), and the contact allowlist scan's unexpected `create_availability_pattern` 42702 and `update_availability_pattern` 23503. Raw output: `docs/evidence/G4_VERIFY_RAW.txt`, `docs/evidence/G4_LIVE_HARNESS_RAW.txt`, `docs/evidence/G4_UNIT_VERBOSE_RAW.txt`. The same run's isolated G3 token, expiry, use-limit, rate-limit, C2, caller-only expiry, and C4 cases passed. That is not Day 4 acceptance. No new migration. DEV was not migrated.

**G5 — 2026-11-07, DEV.** Preflight ref match `yes`, pooler host `yes`, read-only connection `success`. `npm run db:migrate` skipped `0001`–`0025` (already applied). Catalogue: 33 public tables with RLS, `tables_without_rls=0`, 69 public functions with zero anon EXECUTE, zero SECURITY DEFINER without fixed search_path, unqualified-extension query `[]`. Raw: `docs/evidence/G5_2026-11-07_DEV_MIGRATE.txt`, `docs/evidence/G5_2026-11-07_DEV_DATABASE_EVIDENCE.txt`. DEV live harness NOT RUN (fixture commit without cleanup). Day 4 remains `[~]`.

**G6 — 2026-11-07.** User confirmed G1–G5 evidence. Merged `wip/day4-stabilisation` into `main` at `898da403a51125ca44add057eaf0d576779cd248`. Day 2/3/4 `[x]` sub-items above cite only the named passing live tests; aggregate Day 2/3/4 remain `[~]`. Confirmed G4 failures stay open. No new migration or live rerun. Day 5 is not started by G6. Details: `docs/G6_MERGE_REPORT.md`.

## [x] Day 5 — ledger, consent, handover, notice, and report

- Create append-only `swap_ledger_entries` with counts only. Entries are pair-specific and non-transferable, never carry money/price/amount, expire after eight weeks, schedule a week-six reminder job, and expire silently. The ledger must never create a negative balance across a pair or transfer balance to another pair.
- Default communication to email relay. After acceptance, require plain-language, versioned, timestamped, revocable mobile-number-sharing consent limited to the swap partner and specifically chosen backups. Revoking consent ends that swap. No school notice may contain a mobile number.
- Add two-step handover: **Pickup done**, then **Child arrived safely**. Mark a trip complete and post its ledger updates only when both sides confirm. Represent the missing second confirmation reminder due 30 minutes after expected arrival.
- Generate a copyable school notice using only year level, date, and collector display name. Include no phone number, email, address, child nickname, trust score, price, or contact data.
- Add IDs-only `first_trip_completed`; test pair isolation/non-negative ledger, consent revocation ending a swap, two-confirmation completion, and phone-free notice output. Produce the Day 5 standard report and wait for **`GO DAY 6`**.

**Day 5 wrap-up — 2026-11-07, TEST only.** Full `npm run verify` exit **0**: unit 47/47; allowlist 69/45/8; RLS **252/252** (migration-contract 46, live-rls 17 incl. C3/G1, rpc-smoke 54, invitation/g3 suites, ledger 27, contact 57, handover 24). Raw: `docs/evidence/DAY5_WRAPUP_VERIFY_RAW.txt`. Aggregate Day 5 stays `[~]` until school notice, outbound email transport, 90-day purge and Day 8 reminder delivery are evidenced. Do not start Day 6 without **`GO DAY 6`**.

### [x] Task 5.1 — immutable membership-pair trip-count ledger

- Add `swap_ledger_entries` with `from_membership` (recipient/debtor), `to_membership` (provider), `swap_leg_id`, integer `trip_count_delta`, `created_at`, eight-week `expires_at` and week-six `reminder_due_at`. No transferable/third-party or amount/price/currency/money-balance field.
- Derive exactly one +1 entry from each completed accepted swap leg. No client INSERT; UPDATE, DELETE and TRUNCATE are revoked and rejected by raising triggers. Preserve source completion identity and pair integrity.
- Add caller-derived, no-argument `get_my_ledger` exposing only the caller's own active-school pair entries, with nonnegative net counts per partner. Reverse-direction trips offset only that pair. Return a computed `is_expired` marker; exclude expired rows from netting without mutating/deleting them or issuing penalties.
- Prove with live non-privileged authenticated tests: own updates/deletes denied; direct inserts denied; School B parent/moderator and same-school nonparticipants cannot read; catalog has no monetary columns; expired entries do not net; completion emits exactly one entry. Every new function has explicit grants, pg_catalog-only path, an allowlist record and cross-school coverage; new table RLS is live-tested.
- Completion is a trusted `swap_legs.completed_at` integration hook only. The two-step handover and reminder delivery remain separate future tasks. Run new live tests on the TEST project only; do not seed or migrate DEV in this task.

**Passing live evidence:** `tests/rls/ledger-live.test.ts`, 27/27 on the separate TEST project; raw runner output `docs/evidence/TASK_5_1_LEDGER_LIVE_RAW.txt`. Re-run 2026-11-07: 27/27, `docs/evidence/TASK_5_1_LEDGER_LIVE_RERUN_RAW.txt`. Exact passing names include:

- `trusted completion posts exactly once even after an unchanged completion update`
- `records recipient membership as debtor and helper membership as provider for both participants`
- `denies participant UPDATE and DELETE and leaves the owned ledger entry unchanged`
- `denies authenticated INSERT and TRUNCATE rather than exposing raw ledger writes`
- `blocks a verified same-school third party from another membership pair directly and through the RPC`
- `blocks School B parentB from School A rows and RPC data while allowing their own pair`
- `blocks School B moderatorB from School A rows and RPC data while allowing their own pair`
- `retains nine-week history with dynamic is_expired but excludes it from active partner counts`
- `uses exactly 42 and 56 elapsed UTC days for reminder and expiry in a non-UTC session`
- `nets reverse trips only within the same pair without affecting a different partner`
- `silently expires history without deleting or mutating rows, issuing audits, or changing scores`
- `guard rejects privileged UPDATE DELETE and TRUNCATE with 55000 despite existing grants`
- `rejects a malformed cross-school or unrelated membership pair before uniqueness can mask validation`
- `denies participant and cross-school client completion writes and authenticated trigger calls`
- `catalogue confirms SELECT-only RLS, one entry per leg, +1 counts and no monetary public columns`
- `restricts RPC execution to its allowlist and all three function search paths to pg_catalog only`
- `denies actual anon execution of the ledger RPC and both trigger functions`

This completion applies to Task 5.1's TEST-backed ledger only, not the broader Day 5 workflows or DEV deployment. Historical G1/C3 failures remain open and are not waived.

**Task 5.1 full verify (historical):** TypeScript, ESLint, 31 unit tests, 40 static RLS contracts, the allowlist gate (57 public functions / 39 authenticated / 2 internal), the smoke suite and all 27 ledger live tests passed. RLS total: 83 passed / 2 failed; exit code 1 due to unchanged C3/G1 failures. Source: `docs/evidence/TASK_5_1_VERIFY_RAW.txt`. Post-run ledger fixture school/user/entry counts are all zero (`TASK_5_1_CLEANUP_RAW.json`).

### [~] Task 5.2 — scoped contact consent and immediate revocation

- Create versioned `contact_consents` records with swap/member, consent version, grant/revocation timestamps and partner-plus-chosen-backups-only scope. Limit chosen backups to the school's configured maximum (at most two), approved same-school nonparticipants, with immutable version-specific selection.
- Store mobile numbers only in an RLS-protected private-schema table with no client privileges. Email relay remains the default contact policy. Never copy numbers to public profiles, consent records, logs, analytics, notices or notifications.
- Implement `grant_contact_sharing`, `revoke_contact_sharing` and `get_shared_contact`. Derive caller membership from `auth.uid()`, enforce accepted same-school participant ownership, version subsequent grants, and release numbers only to the current swap partner or explicitly chosen backup while the owner's consent and swap remain active.
- Revocation atomically records the time, ends the swap as `cancelled_consent_revoked`, emits an append-only cancellation event and places a phone-free in-app notification in the partner's own inbox. Repeated revocation must not duplicate events or notifications; no future grant may revive that cancelled swap.
- Live tests as non-superuser authenticated users: partner and chosen backup positive reads; unrelated/School B/anon denials; immediate read removal for both sides/backups after revoke; state/event/partner-notification assertions; version history; private table direct-read denial; catalog and all-allowed-RPC response checks for number leakage. Every new table has RLS plus live coverage and new functions have explicit grants, pg_catalog-only paths and allowlist records.
- Do not claim external email delivery without a configured transport. This task implements partner notification in-app; email relay is the default policy, not a fabricated sent email.

#### [x] Task 5.2 — versioned private sharing, access removal, atomic cancellation and in-app partner notification

Passing TEST evidence: `tests/rls/contact-live.test.ts`, **57/57 PASS** in the final full run, with every live name and safe per-RPC outcome in `docs/evidence/TASK_5_2_VERIFY_RAW.txt`. Re-run 2026-11-07: **57/57 PASS**, `docs/evidence/TASK_5_2_CONTACT_LIVE_RERUN_RAW.txt` (privacy scan: `accept_current_consent` known legacy `42702` only; no phone leak). These exact passing names support this narrow backend completion:

- `acceptedpartnerSuccess: both accepted partners read only the other consenting membership`
- `chosenbackupSuccess: two explicitly chosen verified same-school backups can read the owner`
- `deniedReader-parentB: unchosen unrelated same-school School B and moderator B receive NULL`
- `deniedReader-moderatorB: unchosen unrelated same-school School B and moderator B receive NULL`
- `anonymousDenied: anon cannot execute any contact RPC even for a known consent`
- `privateSchemaTableDenied: even owner partner and chosen backup cannot directly read or write private phones`
- `version1to2Snapshots: regrant supersedes without revocation or cancellation and replaces the chosen backup set`
- `revokeLifecycle: latest consent revocation cancels with retained acceptance event partner-only phone-free inbox and immediate NULL both ways`
- `idempotentRevoke: repeat owning revocation preserves exact timestamps history event and single inbox row`
- `noRevival: neither owner may regrant or accept a consent-cancelled swap`
- `unchangedLedgerAfterCancel: consent withdrawal preserves immutable completed trip entries and pair counts`
- `catalogPrivacy: no public phone columns or views referencing the private phone table and no private client privileges or policies`
- `catalogTables: every new table has RLS SELECT-only client grants and exact consent and backup metadata columns`
- `catalogFunctions: three contact RPCs have explicit authenticated-only EXECUTE and all five pg_catalog paths with internal execution denied`
- `allAllowlistedRPCResponseLeakScan: every allowlisted RPC is actually called in a rollback savepoint with only the scoped dedicated getter exception`

The four new public tables and private mobile table all have RLS and live coverage. Client DML denial has individual `noDirectDML-*` passing cases. Privileged fixture construction/read-back is not counted as an RLS assertion. New SQL was applied to TEST only. Zero new fixture schools/users/consents/numbers/backups/events/inbox remain (`TASK_5_2_CLEANUP_RAW.json`).

**Current full verify:** TypeScript/lint PASS; unit 38/38, static contracts 44/44, ledger 27/27, contact 57/57 and smoke 1/1 PASS; allowlist 62 public / 42 authenticated / 4 internal PASS. Overall RLS **144 PASS / 2 FAIL**, exit **1** due to unchanged legacy C3/G1. The response scan also identifies existing `accept_current_consent` and `refresh_my_availability_instances` SQLSTATE `42702`, explicitly not functional success. No legacy assertion was skipped/weakened.

**Task 5.2 remains [~] overall:** outbound email relay transport is not configured, so email is only the default policy; notification delivery is in-app. Existing 90-day purge execution is still unimplemented; no real-login browser walkthrough or DEV migration is claimed. Backup selection currently requires membership IDs rather than a discovery picker. Do not mark broader Day 5 complete or start another task.

### [x] Task 5.3 — two-step, role-bound handover

- Create RLS-protected `swap_leg_confirmations`: `pickup_done` only by the leg provider, `child_arrived` only by the leg recipient. Derive membership and school from auth.uid() and accepted source leg; store server timestamps. Immutable confirmation facts, one record per leg/kind, timestamp-preserving duplicate taps.
- `confirm_pickup_done` and `confirm_child_arrived` accept only a leg UUID, no caller/school/time arguments. Either order is valid; only both confirmations complete the leg. Completion and Task 5.1's exactly-one recipient-to-provider ledger entry are atomic.
- Expected arrival defaults to the end of the recipient's requested service window in the school's timezone. Preserve it after handover starts. If exactly one confirmation exists and the other is still missing at expected arrival + 30 minutes, create one reminder record for the missing confirmer. Never create before the threshold, with zero/both confirmations or for a cancelled swap. Day 8 delivery is not built now.
- Add own-participant reminder refresh plus a service-only database sweep; attempt native TEST scheduling for durable reminder-record creation without relying on the Sandbox process. Never describe source/worker readiness as an activated schedule.
- Emit `first_trip_completed` once per participating user on completion. Actors come from immutable confirmations previously derived from auth.uid(), school from the accepted source leg; no caller-supplied attribution. No child data, contact number, amount, price, currency, location or free-form analytics payload.
- Live tests under non-superuser authenticated synthetic claims prove role and cross-school denial, both orders, one-confirmation incompleteness, timestamp/idempotency, reminder timing, exactly-one ledger and correct/unique analytics. Every new function has explicit grants, pg_catalog-only path, allowlist and cross-school coverage; every new table has RLS and live coverage. Preserve existing test failures and report raw output.

**Passing TEST evidence:** `tests/rls/handover-live.test.ts`, 24/24 PASS in both the dedicated run and full harness. Every subtest name and raw runner output are retained in `docs/evidence/TASK_5_3_LIVE_RAW.txt`; the full `npm run verify` output is `docs/evidence/TASK_5_3_VERIFY_RAW.txt`. Re-run 2026-11-07: **24/24 PASS**, `docs/evidence/TASK_5_3_HANDOVER_LIVE_RERUN_RAW.txt` (includes reminderBoundary ±29/±31, bothOrders, duplicateTaps, wrongCaller, catalogFunctions). Native TEST cron `yourturn-handover-reminder-records` is active and an observed run succeeded (`TASK_5_3_CRON_RUNS_RAW.json`). `npm run build` and `npm run check:secrets` passed (`TASK_5_3_BUILD_RAW.txt`). The aggregate gate remains exit 1 because of unchanged C3 and G1 tests; this does not negate the dedicated handover cases and does not mark Day 5 complete.

**Not in Task 5.3 / Day 5 remains [~]:** school notice generation is not implemented; Task 5.2's outbound email relay and 90-day purge remain unconfigured. Handover reminder delivery is Day 8 and is not included; this task records due reminders only. No DEV migration, live login/browser acceptance or publication is claimed.

## [x] Day 6 — trust scoring, bands, holds, and appeals

Branch: `wip/day6-trust` (from `main` @ Day 5 wrap-up tip). Apply new SQL/fixtures to TEST only. Exact trust scores never leave the database to other parents; clients see **bands** only (`Trusted` / `Standard` / `Caution` / `Restricted` / `Suspended`). No amount/price/currency. Safety features stay free. No live location. Child data remains nickname + year level only.

**Day 6 wrap-up — 2026-11-07, TEST only.** Full `npm run verify` exit **0**: unit **47/47**; allowlist `97/58/23`; RLS **306/306** (migration-contract, live-rls, rpc-smoke, invitation/g3, ledger, contact, handover, trust, trust-deltas, trust-holds). Raw: `docs/evidence/DAY6_WRAPUP_VERIFY_RAW.txt`. Tasks 6.1–6.3 evidenced `[x]`. Running-late notice posting later evidenced under Day 7 Task 7.4; aggregate Day 6 closed `[x]` at Day 7 wrap.

**Baseline (Day 6 start):** Day 5 wrap-up `npm run verify` exit 0 on TEST (47 unit / 252 RLS). Day 6 start verification raw: `docs/evidence/DAY6_START_VERIFY_RAW.txt`.

- Consume Day 3 `schedule_cancellation_events` and Day 5 completion/cancellation facts under the published trust policy: completed trip +1; eligible urgent cover +3 (within four hours of pickup, max two/week, no same-household); cancel under 24 hours -3, under two hours -8; late 15+ minutes after window start -2 with prior running-late notice else -5; confirmed no-show -20 (or -10 if backup accepts) plus two trips owed; confirmed false report -15; reviewed safety violation -25.
- Keep scores server-side; expose band only to other parents. Thresholds/actions only via immutable published `trust_policy_versions`.
- Provisional no-show reports (24 hours undisputed or moderator-confirmed); appeals within 48 hours; moderator safety hold disables swaps only, alerts admin, review within 24 hours, appealable.
- Every new table: RLS + live test. Every new function: explicit grants, `search_path = pg_catalog` only, allowlist entry, cross-school live test. Non-privileged `authenticated` + synthetic JWT claims.

### [x] Task 6.1 — score ledger and band projection

Append-only `trust_score_events`; `apply_trust_score_delta` (internal); `get_my_trust` / `get_peer_trust_band`; School B denied School A events/bands; peers never receive numeric scores. Live **6/6** (`npm run test:trust:live`). Raw: `docs/evidence/TASK_6_1_TRUST_LIVE_RAW.txt`. Migrations `0027`–`0030`.

### [x] Task 6.2 — policy-driven deltas from trips and cancellations

Published-policy deltas on completion (+1 helper), schedule/swap cancels (−3/−8 by lead time), urgent cover on accept (+3 with 4h/weekly/household rules). Idempotent once-per-fact. Live **6/6** (`npm run test:trust-deltas:live`). Raw: `docs/evidence/TASK_6_2_TRUST_DELTAS_LIVE_RAW.txt`. Migration `0031`.

### [x] Task 6.3 — no-show, false-report, safety hold, and appeal

Provisional no-show/false-report; moderator confirm/reject and 24h sweep; safety hold (swap-only disable); 48h appeals; no-show trip penalties (+2) via `trust_trip_penalties`; append-only audit. Live **6/6** (`npm run test:trust-holds:live`). Raw: `docs/evidence/TASK_6_3_TRUST_HOLDS_LIVE_RAW.txt`. Migration `0032`. Running-late notice store deferred to Day 7 Task 7.4.

## [x] Day 7 — school notice, email relay, retention purge, and running-late notices

Branch: `wip/day7-notices-retention` (from Day 6 wrap tip `5f9de3d` on `wip/day6-trust`). Apply new SQL/fixtures to TEST only. No amount/price/currency. Safety features stay free. No live location. Child data remains nickname + year level only. School notices never include phone, email, address, nickname, trust score, or contact data. **Handover reminder delivery is Day 8 and is out of scope.**

**Day 7 wrap-up — 2026-11-07, TEST only.** Full `npm run verify` exit **0**: TypeScript/ESLint clean; unit **47/47**; allowlist `132/72/44`; RLS **376/376** across 15 files (migration-contract, live-rls, rpc-smoke, invitation/g3, ledger, contact, handover, trust, trust-deltas, trust-holds, school-notice, email-relay, retention-purge, running-late). Raw: `docs/evidence/DAY7_WRAPUP_VERIFY_RAW.txt`. Tasks 7.1–7.4 evidenced `[x]`. No new migration in this wrap-up. DEV not migrated. Wait for **`GO DAY 8`**.

**Baseline (Day 7 start):** Day 6 wrap-up `npm run verify` exit 0 on TEST (47 unit / 306 RLS; allowlist 97/58/23). Day 7 start verification raw: `docs/evidence/DAY7_START_VERIFY_RAW.txt`. No new migration in this start task.

- Close Day 5/6 operational residuals that are not Day 8 delivery: phone-free school notice copy, configurable outbound email relay transport (server admin module only), 90-day purge of departure/contact/notice logs after a swap ends, and running-late notice posting that feeds late trust deltas (−2 with prior notice before window start, else −5).
- Every new table: RLS + live test. Every new function: explicit grants, `search_path = pg_catalog` only, allowlist entry, cross-school live test. Non-privileged `authenticated` + synthetic JWT claims.

### [x] Task 7.1 — phone-free school notice and moderation

- Generate a copyable school notice from an accepted swap using only year level(s), date, and collector display name. Exclude phone number, email, address, child nickname, trust score, price, and contact data.
- Persist notice generation/access logs needed for the 90-day retention policy without storing forbidden fields. School moderator queue + withdraw. RLS + live cross-school denial. Explicit grants, pg_catalog-only path, allowlist entry.

**Passing live evidence:** `tests/rls/school-notice-live.test.ts`, **6/6** on TEST (`npm run test:school-notice:live`). Raw: `docs/evidence/TASK_7_1_SCHOOL_NOTICE_LIVE_RAW.txt`. Migrations `0033`–`0034`. Allowlist after: `107` public / `63` authenticated / `28` internal. Exact passing names:

- `generatePhoneFreeNotice: accepted participant creates year-date-collector copy without nickname or contact`
- `moderationQueueAndWithdraw: school moderator lists and withdraws; generator cannot revive by regenerate until after withdraw`
- `crossSchoolAndRoleDenials: stranger School B parent/moderator and anon cannot generate read or moderate School A notices`
- `noDirectDmlAndImmutable: clients cannot insert update delete truncate notices or access logs`
- `listMineAndGet: participants list and get own notice; payload stays phone-free`
- `catalogAllowlistAndSearchPath: new tables RLS SELECT-only; RPCs allowlisted with pg_catalog paths; no money fields`

### [x] Task 7.2 — outbound email relay queue, masking, and delivery policy

- Published `email_relay_delivery_policies` with server_admin_only transport; `handover_reminder` excluded (Day 8). Outbound `email_relay_queue` + append-only delivery events. Masked recipient displays only; raw email only via service-role claim. Server module `server/admin/email-relay.ts`. No secrets in client bundles. No mobiles/amount/price/currency in relay tables.

**Passing live evidence:** `tests/rls/email-relay-live.test.ts`, **6/6** on TEST (`npm run test:email-relay:live`). Raw: `docs/evidence/TASK_7_2_EMAIL_RELAY_LIVE_RAW.txt`. Migrations `0035`–`0036`. Allowlist after: `120` public / `68` authenticated / `36` internal. Exact passing names:

- `enqueueMasksRecipient: partner enqueue returns masked address only and never raw email or mobile`
- `deliveryPolicyBlocksHandoverAndExposesTransport: policy excludes Day 8 reminders; handover enqueue denied`
- `crossSchoolAndRoleDenials: stranger School B parent/moderator cannot enqueue or read School A queue`
- `claimAndCompleteServiceOnly: authenticated denied; privileged claim exposes email once then marks sent`
- `noDirectDmlAndCatalogPrivacy: clients cannot mutate queue; no email phone money columns`
- `catalogAllowlistAndSearchPath: RLS SELECT-only; RPCs allowlisted; claim internal to service_role`

### [x] Task 7.3 — 90-day retention purge

- Enforce deletion of departure checks, contact disclosures, notice logs, and email-relay rows 90 days after a swap ends. Service-role `purge_expired_disclosure_retention` with GUC `yourturn.retention_purge=1`; append-only departure logs and purge-run counters; ledger/trust/children/confirmations/cancellation events preserved. Fixed search_path helpers, allowlist entries, live proof that in-window rows remain and expired rows are purged.

**Passing live evidence:** `tests/rls/retention-purge-live.test.ts`, **5/5** on TEST (`npm run test:retention-purge:live`). Raw: `docs/evidence/TASK_7_3_RETENTION_PURGE_LIVE_RAW.txt`. Migrations `0037`–`0038`. Allowlist after: `125` public / `69` authenticated / `40` internal. Exact passing names:

- `purgesExpiredKeepsInWindow: 91-day disclosures and logs removed; 89-day retained`
- `preservesLedgerTrustAndChildren: purge never deletes ledger trust events or child profiles`
- `authenticatedDeniedCrossSchool: parents and School B cannot run purge or read foreign departure logs`
- `noClientDeleteWithoutPurgeFlag: ordinary deletes of disclosures still raise 55000`
- `catalogAllowlistAndSearchPath: new tables RLS; purge service-only; no money fields`

### [x] Task 7.4 — running-late notice store

- Persist a prior running-late notice before the pickup window start so Day 6 late-arrival scoring can apply −2 instead of −5. Helper-only post; participant read; School B denied School A; clients cannot forge notices after window start. `pickup_done` confirmation posts `late_with_advance_notice` (−2) or `late_without_advance_notice` (−5). RLS + live tests. Day 7 feature work complete; wait for **`GO DAY 8`**.

**Passing live evidence:** `tests/rls/running-late-live.test.ts`, **6/6** on TEST (`npm run test:running-late:live`). Raw: `docs/evidence/TASK_7_4_RUNNING_LATE_LIVE_RAW.txt`. Migration `0039`. Allowlist after: `132` public / `72` authenticated / `44` internal. Exact passing names:

- `postBeforeWindowAndRead: helper posts before window; partner reads; idempotent`
- `rejectAfterWindowStart: helper cannot post once pickup window has started`
- `lateWithoutNoticePenalty: 15+ minutes late without prior notice posts -5`
- `lateWithPriorNoticePenalty: prior notice before window yields -2 on late pickup`
- `crossSchoolAndRoleDenials: School B and requester cannot post or read School A notice`
- `noClientMutateAndCatalog: direct DML denied; RLS on; no money or location fields`

## [x] Day 8 — discussion community and handover reminder delivery

Branch: `wip/day8-community` (from Day 7 wrap tip `7dd7e28` on `wip/day7-notices-retention`). Apply new SQL/fixtures to TEST only. No amount/price/currency. Safety features stay free. No live location. Child data remains nickname + year level only. Community posts stay school-scoped and must not expose phone, email, address, trust score, or contact data.

**Day 8 wrap-up — 2026-11-07, TEST only.** Full `npm run verify` exit **0**: TypeScript/ESLint clean; unit **47/47**; allowlist `160/85/59`; RLS **429/429** across 18 files (migration-contract, live-rls, rpc-smoke, invitation/g3, ledger, contact, handover, trust, trust-deltas, trust-holds, school-notice, email-relay, retention-purge, running-late, community, community-moderation, handover-reminder-delivery). Raw: `docs/evidence/DAY8_WRAPUP_VERIFY_RAW.txt`. Tasks 8.1–8.3 evidenced `[x]`. No new migration in this wrap-up. Wrap-up stabilised ledger completion-name allowlist for `list_my_handover_reminder_deliveries` and handover truncate denial for FK `0A000`. DEV not migrated. Wait for **`GO DAY 9`**.

**Baseline (Day 8 start):** Day 7 wrap-up `npm run verify` exit 0 on TEST (47 unit / 376 RLS; allowlist 132/72/44). Day 8 start verification raw: `docs/evidence/DAY8_START_VERIFY_RAW.txt`. No new migration in this start task.

- School-scoped discussion community: verified same-school parents can post and reply; volunteer moderators can moderate own-school threads; School B denied School A reads/writes; no live location or money fields.
- Handover reminder **delivery** (Day 5 residual): recheck live eligibility before send; allow `handover_reminder` through the Day 7 email-relay path for due `swap_leg_reminders` only; no premature delivery.
- Every new table: RLS + live test. Every new function: explicit grants, `search_path = pg_catalog` only, allowlist entry, cross-school live test. Non-privileged `authenticated` + synthetic JWT claims.

### [x] Task 8.1 — school-scoped discussion threads

- Persist school-scoped discussion threads, posts, comments and likes with RLS. Verified same-school members create/list/comment/like via RPCs; School B denied School A; privacy filter rejects phones, emails, photo phrasing and child full-name phrasing; no phone/email/address/nickname/trust score/amount/price/currency fields. Direct client DML denied. Explicit grants, pg_catalog-only path, allowlist, live cross-school denial. Australian English UI copy in Community hub.

**Passing live evidence:** `tests/rls/community-live.test.ts`, **5/5** on TEST (`npm run test:community:live`). Raw: `docs/evidence/TASK_8_1_COMMUNITY_LIVE_RAW.txt`. Migration `0040`. Allowlist after: `145` public / `79` authenticated / `50` internal. Exact passing names:

- `createListCommentLike: same-school parents create thread, post, comment and toggle likes`
- `privacyTextRejected: phones emails photos and child full-name phrasing are denied`
- `crossSchoolDenials: School B cannot create list read or like School A community content`
- `noDirectDml: clients cannot insert update delete community tables directly`
- `catalogAllowlistAndSearchPath: new tables RLS; RPCs allowlisted; no money or photo fields`

### [x] Task 8.2 — community moderation

- Unique same-school reports with privacy-filtered reasons; auto-hide after three unique reports; own-school moderator hide/restore/remove and moderation queue; append-only `community_reports` / `community_moderation_actions` audit. Authors cannot self-report; parents cannot forge moderator actions. School B denied School A. RLS + live tests.

**Passing live evidence:** `tests/rls/community-moderation-live.test.ts`, **5/5** on TEST (`npm run test:community-moderation:live`). Raw: `docs/evidence/TASK_8_2_COMMUNITY_MODERATION_LIVE_RAW.txt`. Migrations `0041`–`0043`. Allowlist after: `155` public / `84` authenticated / `55` internal. Exact passing names:

- `reportAutoHideRestoreRemove: three unique reports auto-hide; moderator restore then remove`
- `moderatorHideAndParticipantCannotForge: moderator hide works; parents denied hide restore remove`
- `crossSchoolDenials: School B cannot report hide restore remove or queue School A content`
- `noDirectDml: clients cannot insert update delete reports or moderation actions`
- `catalogAllowlistAndSearchPath: new tables RLS; RPCs allowlisted; no money or photo fields`

### [x] Task 8.3 — handover reminder delivery

- Deliver due handover reminders only after rechecking live eligibility (exactly one confirmation, accepted incomplete leg, past due). Wire through server-admin email relay with `handover_reminder` kind unblocked for this path alone. Authenticated cannot claim/send or enqueue handover reminders. Completed/cancelled reminders are suppressed without queueing. Live proof of eligibility gate and School B isolation. Day 8 feature work complete; wait for **`GO DAY 9`**.

**Passing live evidence:** `tests/rls/handover-reminder-delivery-live.test.ts`, **5/5** on TEST (`npm run test:handover-reminder-delivery:live`). Raw: `docs/evidence/TASK_8_3_HANDOVER_REMINDER_DELIVERY_LIVE_RAW.txt`. Migration `0044`. Allowlist after: `160` public / `85` authenticated / `59` internal. Exact passing names:

- `deliverEligibleQueuesAndClaims: overdue reminder queues handover_reminder then service claim completes`
- `suppressCompletedAndCancelled: delivery recheck suppresses resolved reminders without queueing`
- `crossSchoolDenials: School B cannot read School A deliveries or enqueue foreign handover mail`
- `noDirectDml: clients cannot insert update delete delivery rows or forge handover queue`
- `catalogAllowlistAndSearchPath: delivery table RLS; RPCs allowlisted; no money fields`

## [~] Day 9 — free giveaway and second-hand listing board

Branch: `wip/day9-listings` (from Day 8 wrap tip `bdb83b3` on `wip/day8-community`). Apply new SQL/fixtures to TEST only. No amount/price/currency. Safety features stay free. No live location. Child data remains nickname + year level only. Listings are free giveaway/lending only; restricted items are admin-editable; school-scoped with cross-school denial.

**Baseline (Day 9 start):** Day 8 wrap-up `npm run verify` exit 0 on TEST (47 unit / 429 RLS; allowlist 160/85/59). Day 9 start verification raw: `docs/evidence/DAY9_START_VERIFY_RAW.txt`. No new migration in this start task.

- School-scoped free item board: verified same-school parents can create/list free giveaway or lending listings; no price/amount/currency fields; no child photos or full names; School B denied School A.
- Restricted-item catalogue editable by administrators; blocked items cannot be listed.
- Own-school moderation path for listing withdraw/hide where required; every new table RLS + live test; every new function grants, pg_catalog-only path, allowlist, cross-school live test.

### [x] Task 9.1 — school-scoped free listings

- Persist school-scoped free giveaway/lending listings with RLS. Verified member create/search/filter/read and enquiries; restricted catalogue seeded and enforced (car seats, cots, bassinets, bunk beds, baby walkers, recalled items); School B denied School A; free-only `display_offer_label` text (no amount/price/currency/payment/photo/phone fields). Explicit grants, pg_catalog-only path, allowlist, live cross-school denial.

**Passing live evidence:** `tests/rls/listings-live.test.ts`, **5/5** on TEST (`npm run test:listings:live`). Raw: `docs/evidence/TASK_9_1_LISTINGS_LIVE_RAW.txt`. Migrations `0045`, `0046`. Allowlist after: `174` public / `91` authenticated / `67` internal. Exact passing names:
- `createSearchFilterEnquiry: same-school create search filter get and enquiry flow`
- `restrictedItemsRejected: car seats cots bassinets bunk beds walkers and recalls denied`
- `privacyAndOfferLabel: phones money labels and author self-enquiry denied`
- `crossSchoolDenials: School B cannot create search get enquire or read School A listings`
- `noDirectDmlAndCatalog: clients cannot write tables; RLS and free-only columns hold`

### [ ] Task 9.2 — listing interest and fulfilment

- Same-school interest/claim flow without payment. Status transitions stay free-only. Cross-school denial. RLS + live tests.

### [ ] Task 9.3 — restricted items and listing moderation

- Admin-editable restricted-item catalogue; blocked listings rejected. Own-school moderator withdraw/hide with append-only audit. Cross-school denial. RLS + live tests. Stop after Day 9; wait for **`GO DAY 10`**.
