# YourTurn test plan

## Layered test strategy

`npm run verify` runs TypeScript type checking, ESLint, Vitest unit tests, then RLS tests. `npm run test:e2e` runs Playwright against the mobile-responsive PWA. Both are Day 2 delivery gates.

Unit tests cover client-safe public configuration, key boundaries, public API response shapes, trust-policy defaults, onboarding state transitions, event-name allowlists, consent-document requirements, no-sensitive-child-field schema contracts, and PWA cache exclusions. They must never record raw emails, mobile numbers, child values, invite codes, JWTs, or service-role keys in snapshots or output.

Day 3 unit tests cover weekly pattern expansion across 28 school-local dates, term and holiday exclusion, one-instance versus whole-pattern cancellation, Australia/Melbourne daylight-saving local-time preservation, no-address area-label validation, and ICS escaping/serialization. The RLS contract and live test suite must include household links, patterns, instances, school calendar periods, and immutable cancellation events. A School B parent or moderator must not read or mutate School A schedule/calendar data.

Day 4 unit tests cover configured matching-window eligibility, strict same-date reciprocity versus an explicit different-date opt-in within 28 days, deterministic ranking by time overlap/area label/trust band, pending-versus-accepted child reveal, one-time analytics IDs, and capacity reservation arithmetic. Concurrency tests must attempt simultaneous proposal/accept paths against the same dated instance and prove that one operation fails safely. RLS contracts and the live harness must cover blocks, proposals, reciprocal legs, reservation records, and accepted-swap child reveal. A School B parent/moderator must not read or mutate School A match/swap data, and a blocked synthetic pair must never be returned by a candidate query.

RLS contract tests inspect every migration for every Day 1 and Day 2 table, `ENABLE ROW LEVEL SECURITY`, safe `SECURITY DEFINER` helper functions, permission grants, no direct code/attempt access, append-only audit protections, immutable published policy protections, and IDs-only analytics. A live two-school RLS harness connects only when the isolated `SUPABASE_RLS_TEST_DATABASE_URL` value is supplied. It must apply migrations to a dedicated test database and prove a School B parent and School B moderator cannot read School A data through direct authenticated database queries. It also tests blocked direct analytics writes, forbidden child-profile access, invitation privacy, and immutable-policy changes.

The API suite uses signed-in test JWTs only. It calls Express routes for onboarding status, consent, school options, code redemption, profile/child/declaration completion, invitation handling and moderator approval. It must prove the same School B user/moderator cannot retrieve School A data through an API response. The browser suite covers email verification state, consent, invite-code waiting state, generic invitation opening, post-approval safety declaration, fully complete access, and no unavailable swap/payment UI.

## Test data rules

Use a dedicated Supabase project or isolated test database for migration/RLS testing. Never point fixtures, code seed data, cleanup, or moderator approvals at a real pilot. Test principals and school names must be clearly `yourturn_test_` values. The two browser demo schools are clearly labelled **sample** schools and have test-only codes; production codes are never placed in source or UI.

`SUPABASE_MIGRATION_DATABASE_URL` targets only the development YourTurn project and is read exclusively by `npm run db:migrate`, never by the runtime server or browser bundle. `SUPABASE_RLS_TEST_DATABASE_URL` targets the separate synthetic-data test project; `npm run test:rls` applies migrations to that project before seeding the two-school fixture. Fixture setup may use a privileged connection, but each RLS assertion must run after `SET LOCAL ROLE authenticated`, `SET LOCAL row_security = on`, and synthetic JWT claim setup. The harness must assert that `current_user` is non-superuser `authenticated`; no superuser query or skipped suite is accepted as RLS proof.

## Manual security review

Before each checkpoint, run `npm run check:secrets`, review changed imports, and confirm the only browser-provided Supabase credential is `SUPABASE_ANON_KEY` (or a current publishable key) served from `/api/public-config`. `SUPABASE_SERVICE_ROLE_KEY` stays absent from frontend source, static output, browser payloads, logs, and non-admin server code. Confirm the worker bypasses API, auth, and cross-origin requests.

Review new JSON fields before accepting them. Analytics has no JSON payload. Audit metadata uses an allowlisted, non-personal shape; safety declaration uses explicit boolean facts and version IDs; published trust policy is validated and immutable. Do not rely on documentation comments in place of an enforced database rule.


## Stabilisation evidence — 2026-11-02 (test project only)

`npm run verify` passed against the isolated synthetic-data test project: 27 unit tests and 51 RLS tests passed. The live RLS suite executes with `SET LOCAL ROLE authenticated`, `row_security = on`, and synthetic JWT `sub` claims; its assertion rejects a superuser execution context. It confirms cross-school Day 1–3 isolation, direct mutation denial, current-declaration gating, anonymous function/table privilege denial, and published trust-policy immutability via zero-row/error plus privileged read-back.

This evidence does **not** mark Day 4 complete. The live suite has not yet added the outstanding Day 4 swap-specific acceptance cases: concurrent accept race, reciprocal block-list exclusion, accepted-only child reveal, unapproved matching denial, and School B swap/block/leg RPC mutation attempts. Every new function must have explicit grants, a fixed `search_path`, an allowlist entry, and a cross-school live test. Every new table requires RLS and a live test before it may be marked `[x]`.


## G4 evidence — 2026-11-02 (test project only)

Full `npm run verify` was executed after migrations through `0017`. TypeScript, ESLint, all 27 unit tests, the 39 static migration-contract tests, and the one-test allowlist-driven authenticated RPC smoke suite passed. The function allowlist gate reported `54 public functions, 38 authenticated entries`. The live suite failed 2 of 17 tests: the C3 fixture still made the purported third-party proposal involve the caller in persisted test state, and the G1 expired-invitation fixture violated the invitation status/expiry consistency check. These are unresolved test-fixture failures, not passing evidence. Day 4 remains `[~]`.

## G6 confirmation — 2026-11-07

The user confirmed G1–G5 evidence and authorised merging `wip/day4-stabilisation` into the main checkpoint. This is a source/checkpoint approval only: no new live test, migration, application feature or Day 5 start. Tracker `[x]` sub-items under Days 2, 3 and 4 remain limited to the exact passing live names cited in `TODO.md` and `docs/G6_MERGE_REPORT.md`. Aggregate Day 2/3/4 headings stay `[~]`. Confirmed G4 gate remains exit 1 (C3, G1, availability scan). Confirmed G5 DEV catalogue evidence is `docs/evidence/G5_2026-11-07_DEV_DATABASE_EVIDENCE.txt`. DEV live harness was not run.

## G5 / G6 evidence and checkpoint authorisation — 2026-11-03

The user explicitly confirmed G1–G5 evidence and authorised merging `wip/day4-stabilisation` into the main checkpoint. This is a source/checkpoint approval, not a new test result or a waiver of the passing-live-test requirement for `[x]`. No application code, migration, test assertion or DB data is changed by G6.

G5's DEV preflight returned project-reference match `yes`, pooler host `yes`, and read-only connection `success`. `npm run db:migrate` reported `Applied` for every migration `0001` through `0017`. The subsequent read-only DEV catalogue results are retained verbatim in `docs/evidence/G5_DEV_DATABASE_EVIDENCE.txt`: all public tables have RLS, the count without RLS is `0`, all public functions deny anonymous EXECUTE, no SECURITY DEFINER function lacks an explicitly configured search_path, and the requested unqualified-extension query returns `[]`. Most SECURITY DEFINER functions still use `pg_catalog, public, extensions`; only the six invitation-related RPCs listed in the raw rows use `pg_catalog` only. A fixed-path pass must not be described as a pg_catalog-only pass.

The DEV live harness was NOT RUN: fixture setup commits outside test transactions and `afterAll` only closes the connection. Running it would not satisfy the requested cleanup guarantee. DEV catalogue checks are not live RLS assertion evidence.

## G5 evidence — 2026-11-07 (DEV)

Preflight: migration-URL username project ref equals `SUPABASE_URL` ref `yes`; host is a `*.pooler.supabase.com` host `yes`; read-only `select 1` `success`. The configured RLS-test URL project ref also matched the migration URL project ref (`yes`), so the live harness was treated as unsafe for this target.

`npm run db:migrate` reconciled `0001`–`0025` in order; every file reported `Skipped ... (already applied)`. Raw migrate lines: `docs/evidence/G5_2026-11-07_DEV_MIGRATE.txt`. Read-only catalogue: `docs/evidence/G5_2026-11-07_DEV_DATABASE_EVIDENCE.txt` and `docs/evidence/G5_2026-11-07_DEV_CATALOG.json`. Public tables: **33**, all with RLS enabled; `tables_without_rls` = **0**. Public functions: **69**; every row has `anon_execute: false`; SECURITY DEFINER functions without a fixed search_path: **[]**; unqualified-extension query: **[]**. Search paths observed: `search_path=pg_catalog` (23), `search_path=pg_catalog, public, extensions`, and `search_path=public`. Fixed path is not the same as pg_catalog-only.

DEV live RLS harness: **NOT RUN** — `beforeAll` commits fixtures and `afterAll` only closes the connection; cleanup is not guaranteed.

The latest full test-project run remains G4: 27/27 unit tests; 39/39 migration-contract tests; 1/1 resolution smoke test; 15/17 live tests. The overall verify exit status remains `1` (55/57 RLS assertions passed). C3 and G1 remain red. Do not hide these failures under the user's merge approval. G6 does not retry or fix G1/G3, implement missing acceptance tests, or start Day 5.

The tracker now has narrowly scoped `[x]` sub-items under Days 2, 3 and 4, each citing the exact live test names that passed in G4. Broad day-level workflows remain `[~]`: passing cross-school reads do not establish successful onboarding/household creation/trip acceptance, and a resolution smoke pass does not establish valid end-to-end RPC behaviour. The confirmed direct swap isolation test does not attempt swap-leg writes or every allowed RPC.

Open evidence gaps are maintained explicitly in `docs/G6_MERGE_REPORT.md`. No new passing live test is claimed in this merge task.

## Task 5.1 ledger evidence — 2026-11-03 (TEST only)

Migration `0018_day5_trip_count_ledger.sql` was applied only to the separate test project. The dedicated `tests/rls/ledger-live.test.ts` run passed **27/27**; complete unedited runner output is retained in `docs/evidence/TASK_5_1_LEDGER_LIVE_RAW.txt`. The schema/privilege catalogue rows are in `docs/evidence/TASK_5_1_CATALOG_RAW.json`.

Each case creates random-UUID synthetic schools, parents, memberships and accepted source legs inside its own transaction; `afterEach` always rolls it back, including setup failures. Fixture completion uses labelled privileged SQL because a two-confirmation handover is outside Task 5.1. All participant isolation and client-write assertions call a helper that asserts `current_user = authenticated`, `row_security = on`, `rolsuper = false`, `rolbypassrls = false` and `auth.uid()` equals the synthetic subject. Privileged fixture generation, guard exercise and unchanged-row read-backs are explicitly labelled; they are not substituted for RLS assertions.

The cases prove: no entry before completion; recipient-to-provider +1 exactly once per leg; both participant perspectives; owner update/delete denial; raw insert/truncate denial; same-school nonparticipant and School B parent/moderator isolation via direct SELECT and RPC; blocked pending/rejected/suspended/no-membership/stale-declaration callers; expired history retained but excluded from pair netting; exact 42/56 elapsed-day durations across Sydney DST; reverse-trip offsets stay within a pair and leave another partner untouched; silent expiry has no row/audit/score effects; raising guard rejects UPDATE/DELETE/TRUNCATE even with privileged grants; malformed source pairs are rejected; proposed/declined swaps cannot post; completed source identity cannot be rewritten; no client completion/trigger command; all public-column monetary-name search returns zero rows; new functions have explicit grants and pg_catalog-only paths; actual anon calls to all new functions are denied.

The exact passing names are retained in the raw file and cited in `TODO.md`. `npm run test:ledger:live` reproduces just this ledger gate. `npm run verify` discovers the file automatically; `npm run db:rls:live` now includes it as well. The allowlist checker additionally validates the two internal trigger declarations are not authenticated-executable and all three new functions have the exact `pg_catalog` path. The resolution smoke suite includes `get_my_ledger()`.

No legacy G1/C3 assertion was skipped, altered or relabelled as a pass. Full verify output for this task is retained separately in `docs/evidence/TASK_5_1_VERIFY_RAW.txt`; the final result must be reported independently from the dedicated ledger pass. No DEV fixture test or new DEV migration is performed by Task 5.1.

### Task 5.1 final full-verify result

The completed full run passed TypeScript, ESLint, all 31 unit tests, 40 static RLS contract assertions, the allowlist gate (`57 public functions, 39 authenticated entries, 2 internal declarations`), the one-test RPC smoke suite, all 27 ledger live cases and 15 of the 17 legacy live cases. RLS total is **83 passed / 2 failed (85)**; overall exit code **1**. The two failures are the existing C3 read-back mismatch (both persisted third-party/not-yet-expired rows observed expired) and G1's `school_invitations_check` fixture INSERT failure. They remain open and unchanged.

After both ledger runs, a separate read-only TEST query returned zero leftover ledger-fixture schools, zero synthetic ledger auth users and zero ledger-fixture entries. Raw counts: `docs/evidence/TASK_5_1_CLEANUP_RAW.json`. This cleanup evidence applies to the new ledger tests, not the committed legacy fixture suite. The source checkpoint records Task 5.1's passing scope without declaring the full verify gate green or completing all of Day 5.

## Task 5.2 — private contact consent test boundary

New SQL is applied to the separate TEST project only. `tests/rls/contact-live.test.ts` uses fresh random schools/members/swaps per test, a single transaction and unconditional rollback even after setup failure. Every protected query first asserts `current_role=authenticated`, `rolsuper=false`, `rolbypassrls=false`, `row_security=on` and auth.uid() equals the synthetic subject. Privileged calls are fixture/setup or labelled read-back only; no elevated read is described as an RLS proof. Anonymous tests assert their own nonprivileged identity.

Coverage includes pre-consent NULL; partner and selected-backup positive reads; unrelated, foreign school, moderator, anonymous and impersonation negatives; private schema/table access denial even to owner; consent version/supersession snapshots; same-school approved backup limits; proposed/inactive grant denial; safe withdrawal retained after suspension or stale onboarding; immediate bilateral/backup access removal; terminal status, retained acceptance, one cancellation event and partner-only phone-free inbox; idempotency; no revival; unchanged ledger; direct DML denial; every new table's RLS/grants; exact function signatures, explicit EXECUTE grants and pg_catalog-only paths. The all-allowlisted-RPC response scan calls every allowed public function under the synthetic authenticated subject with rollback savepoints, rejects phone-bearing outputs/errors except the scoped positive dedicated getter, and checks coverage completeness.

The first live run is preserved as `docs/evidence/TASK_5_2_FIRST_LIVE_RAW.txt`: **56 passed / 1 failed**, not a green run. Its final response-leak scan rejected existing unrelated errors: `accept_current_consent` and `refresh_my_availability_instances` returned `42702`; invalid invitation/household lookup calls returned expected `P0002`. No phone-disclosure failure was observed. The privacy scan records these named legacy errors separately from denials/success and does not claim those functions work. No pre-existing test, app function or assertion is weakened to hide them. Fixing those unrelated RPCs is outside Task 5.2; retain them in the bug list. Final run evidence is recorded after completion below.

### Task 5.2 final run — evidence, not an overall green gate

`docs/evidence/TASK_5_2_VERIFY_RAW.txt` records TypeScript PASS, ESLint PASS, 38 unit tests PASS (including 7 contact HTTP tests), 44 static RLS contracts PASS, allowlist PASS (62 public functions, 42 authenticated entries, 4 internal), resolution smoke 1/1 PASS, ledger 27/27 PASS and contact **57/57 PASS**. Combined RLS is **144 PASS / 2 FAIL (146)**. Overall npm verify exit remains **1**, because the unchanged legacy C3 expiry read-back and G1 school_invitations CHECK fixture failures remain. The final contact suite has no filtered/skipped cases. Initial 56/57 failure and the targeted corrected scan's 1-pass/56-filtered output remain preserved separately, not combined into a fictitious first-run success.

The raw log names every live case, including `acceptedpartnerSuccess`, `chosenbackupSuccess`, `deniedReader-parentB`, `deniedReader-moderatorB`, `anonymousDenied`, `privateSchemaTableDenied`, `version1to2Snapshots`, `revokeLifecycle`, `idempotentRevoke`, `noRevival`, `unchangedLedgerAfterCancel`, `noDirectDML-*`, `catalogPrivacy`, `catalogTables`, `catalogFunctions` and `allAllowlistedRPCResponseLeakScan`. The final scan logs all 42 actual calls, including named known_legacy_error/42702 outcomes, without numbers or response bodies. No known legacy error is described as a successful RPC.

`TASK_5_2_CATALOG_RAW.json` contains all 31 public tables and their RLS/policy counts (zero RLS-disabled tables), all 62 public function privilege rows (zero anon EXECUTE), new private-table RLS/no policies/no client privileges, and zero public number/money-like columns or number-backed views. `TASK_5_2_CLEANUP_RAW.json` proves zero leftover contact schools/users/consents/private numbers/backups/events/inbox rows after rollback. `TASK_5_2_BUILD_RAW.txt` records production build and credential-boundary PASS. `TASK_5_2_HTTP_HEALTH_RAW.json` records health/routes 200 and unauthenticated notifications 401/no-store. No real-login browser acceptance, DEV SQL application, outbound mail or scheduled purge execution is claimed.

## Task 5.3 — two-party handover test boundary

Migrations 0020 and 0021 target TEST only. The new tests/rls/handover-live.test.ts uses random handover-a-/handover-b- schools and handover-*@example.invalid auth principals, per-test transactions and unconditional rollback. Every protected query checks authenticated/non-superuser/non-BYPASSRLS, row_security=on and the synthetic auth.uid. Privileged fixture, unchanged-row read-back, raising-trigger exercise and service-only worker checks are labelled infrastructure, not user RLS proof. The full verify discovers all cases; a standalone test:handover:live command reproduces them.

The required cases cover both role-bound confirmations in either order, no one-tap completion, timestamp-preserving duplicates, same-school stranger/School B parent/moderator/pending/no-membership/anon denial, source acceptance, direct DML denial, two new tables' RLS and paths/grants, expected-arrival freezing, 29/31-minute threshold cases, missing-role targeting, zero/both/cancelled/future ineligibility, retained reminder history, one ledger entry per completed leg and first-completion analytics for both immutable confirmation actors with source-derived school. Delivery is Day 8, not this task.

Native TEST cron is registered separately from the SQL migrations. Installation initially failed with 42501 when trying to alter vendor-owned cron metadata; the installer now preserves vendor ownership/policies and validates effective schema access rather than treating inherited table ACL alone as access. Both native job/log tables have RLS and anon/authenticated lack schema USAGE. The fixed per-minute command is public.enqueue_due_handover_reminders(), without any private payload; actual succeeded runs are retained in TASK_5_3_CRON_RUNS_RAW.json. Day 8 must recheck live eligibility before delivery. No DEV schedule is installed.

Independent review found a possible unordered unique-analytics-key lock cycle across separate proposals involving the same actors. 0021 adds ORDER BY actor ID; a static regression test enforces this. A two-session concurrent completion reproduction is not claimed by the rollback-only suite. Existing Day 4 concurrency acceptance remains separate and unproven. Final full-run counts/raw evidence are appended only after completion.

### Task 5.3 foundation assertion reconciliation

The pre-handover ledger catalogue test expected no authenticated function whose name matched `(complet|handover)`. Task 5.3 deliberately introduces `refresh_my_handover_reminders`, and Task 8.3 adds `list_my_handover_reminder_deliveries`; both create/list reminder delivery state and never write completion. The assertion permits exactly those named zero-argument, pg_catalog-only, allowlisted functions, rejects any additional matching function and asserts their bodies cannot UPDATE/INSERT/DELETE swap_legs. It retains all original ledger trigger privilege/path checks, direct completion-write denial and forged getter-argument denial. Both role-bound confirmation RPCs have positive/negative live tests in the handover suite. No legacy C3/G1 test or failing acceptance assertion is changed or skipped.


## Task 5.3 final evidence — 2026-11-03 (TEST only)

The dedicated `tests/rls/handover-live.test.ts` run passed **24/24**. It covered both confirmation orders, one-confirmation incompleteness, duplicate taps/idempotency, provider/recipient role binding, unrelated/School B/pending/suspended/stale-consent denials, anonymous access, cross-school read isolation, direct DML denial, the 29/31-minute reminder boundary, service-only sweep, immutable facts, source freeze, completion analytics, consent cancellation after completion, and exact table/function catalogue contracts. Raw runner output with each test name is `docs/evidence/TASK_5_3_LIVE_RAW.txt`. Native TEST cron install/run outputs are `TASK_5_3_CRON_INSTALL_RAW.json`, `TASK_5_3_CRON_RUNS_RAW.json`, and `TASK_5_3_CRON_TEST_RAW.txt`; the run record observed status `succeeded`. Build and client-secret boundary checks passed (`TASK_5_3_BUILD_RAW.txt`).

The completed full `npm run verify` did **not** pass: TypeScript and ESLint passed; 47 unit tests, 46 migration contracts, the allowlist gate (69 public functions / 45 authenticated / 8 internal declarations), one RPC smoke test, 27 ledger tests, 24 handover tests, and 57 contact tests passed. Total RLS result is **170/172 passed**, overall exit code 1. Only the existing Day 4 tests failed: `C3 expires only the caller own expired proposal with privileged read-back` (two fixture rows read back as `expired` instead of expected `proposed`) and `G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors` (fixture INSERT violates `school_invitations_check`). Neither assertion was modified in this increment. Complete raw aggregate output: `docs/evidence/TASK_5_3_VERIFY_RAW.txt`.

The aggregate run only applied/reconciled migrations against TEST; `0001`–`0021` were already applied. DEV was not migrated. The dedicated Task 5.3 result supports its narrow tracker `[x]`; the overall Day 5 remains `[~]`, and the full verify gate remains red. No school notice, Day 8 delivery, real-login walkthrough or publication is claimed.

## Day 5 wrap-up — 2026-11-07 (TEST only)

Full `npm run verify` exit **0**. TypeScript passed, ESLint passed, unit **47/47**, allowlist `69 public / 45 authenticated / 8 internal`, RLS **252/252**. Raw: `docs/evidence/DAY5_WRAPUP_VERIFY_RAW.txt`.

Suite counts inside that run: migration-contract 46; live-rls 17 (including C3 and G1); rpc-smoke 54; g3-live and invitation-live covered in the 252; ledger-live 27; contact-live 57; handover-live 24. Privacy scan records only `accept_current_consent` as known legacy `42702` (not a phone leak).

A first wrap-up attempt failed one static migration-contract assertion on Windows because concatenated migration SQL retained CRLF while newline-sensitive regexes expected LF. `tests/rls/migration-contract.test.ts` now normalises `\r\n` to `\n` before matching. Re-verify then passed. No new SQL migration in this wrap-up. DEV was not migrated.

Day 5 aggregate remains `[~]`: school notice is unimplemented; Task 5.2 outbound email relay and 90-day purge remain open; handover reminder **delivery** is Day 8. Narrow Task 5.1 / 5.2 backend / 5.3 live scopes stay evidenced `[x]` as cited in `TODO.md`.

## Day 6 start — 2026-11-07 (TEST only)

**TASK DAY 6** opened work on branch `wip/day6-trust`. Scope (from `docs/DECISIONS.md` / `TODO.md`): policy-driven trust deltas, band-only peer disclosure, provisional no-show/false-report, moderator safety hold and appeals. No Day 6 SQL or live trust suite exists yet at branch open.

Baseline milestone verification reused the green Day 5 wrap-up gate and re-ran `npm run verify` on TEST at Day 6 start: exit **0**; unit **47/47**; allowlist `69/45/8`; RLS **252/252**. Raw: `docs/evidence/DAY6_START_VERIFY_RAW.txt`. No new migration in this start task. **Day 7 is not started.**

## Task 6.1 — 2026-11-07 (TEST only)

Trust score engine + band-only peer exposure on TEST. Migrations `0027_day6_trust_score_engine.sql`, `0028_day6_trust_score_clamp_cast.sql`, `0029_day6_trust_score_clamp_case.sql`, `0030_day6_trust_score_audit_payload.sql`. Live suite `npm run test:trust:live`: **6/6** pass. Raw: `docs/evidence/TASK_6_1_TRUST_LIVE_RAW.txt`. Allowlist after: `74` public / `47` authenticated / `11` internal (`get_my_trust`, `get_peer_trust_band` authenticated; `apply_trust_score_delta`, `guard_trust_score_events`, `trust_band_for_user` internal). Cross-school peer band denied; peers never receive numeric scores. DEV not migrated.

## Task 6.2 — 2026-11-07 (TEST only)

Policy-driven trust deltas on TEST. Migration `0031_day6_trust_policy_deltas.sql`. Live suite `npm run test:trust-deltas:live`: **6/6** pass. Raw: `docs/evidence/TASK_6_2_TRUST_DELTAS_LIVE_RAW.txt`. Allowlist after: `82` public / `47` authenticated / `19` internal (+8 internal helpers/triggers). Completion +1 to helper; schedule/swap cancel −3/−8 by lead time; urgent cover +3 on accept with 4h window, weekly cap and household exclusion. Cross-school event reads and client `apply_trust_score_delta` denied. DEV not migrated.

## Task 6.3 — 2026-11-07 (TEST only)

Trust holds, appeals, no-show/false-report on TEST. Migration `0032_day6_trust_holds_appeals.sql`. Live suite `npm run test:trust-holds:live`: **6/6** pass. Raw: `docs/evidence/TASK_6_3_TRUST_HOLDS_LIVE_RAW.txt`. Allowlist after: `97` public / `58` authenticated / `23` internal. Confirmed no-show −20 (−10 with backup) plus two trip penalties; false-report −15; upheld hold −25 (`reviewed_safety_violation`); active hold blocks swap accept; appeal uplift lifts hold; School B denied School A resolution/reads. Running-late notice store not added. DEV not migrated. Day 7 not started.

## Day 6 wrap-up — 2026-11-07 (TEST only)

Full `npm run verify` on TEST exit **0**. TypeScript and ESLint clean. Unit **47/47**. Allowlist `Function allowlist verified: 97 public functions, 58 authenticated entries, 23 internal declarations.` RLS config `tests/rls/**/*.test.ts`: **306/306** across 11 files (migration-contract, live-rls incl. C3/G1, rpc-smoke, invitation/g3, ledger-live, contact-live, handover-live, trust-live, trust-deltas-live, trust-holds-live). Raw: `docs/evidence/DAY6_WRAPUP_VERIFY_RAW.txt`. No new migration in this wrap-up. DEV not migrated. Contact privacy scan includes Day 6 RPCs; only `accept_current_consent` remains known legacy `42702` (not a phone leak). Running-late notice posting moved to Day 7 Task 7.4 and closed at Day 7 wrap; aggregate Day 6 `[x]`.

## Day 7 start — 2026-11-07 (TEST only)

**TASK DAY 7** opened work on branch `wip/day7-notices-retention` from the Day 6 wrap tip. Scope (from Day 5/6 residuals in `docs/DECISIONS.md` / `TODO.md`): phone-free school notice; outbound email relay transport; 90-day purge of departure/contact/notice logs; running-late notice store for late trust deltas. **Handover reminder delivery remains Day 8 and is not started.**

Baseline milestone verification reused the green Day 6 wrap-up gate and re-ran `npm run verify` on TEST at Day 7 start: exit **0**; unit **47/47**; allowlist `97/58/23`; RLS **306/306**. Raw: `docs/evidence/DAY7_START_VERIFY_RAW.txt`. No new migration in this start task. Tasks 7.1–7.4 are open; no Day 7 feature SQL or live suite exists yet at branch open.

## Task 7.1 — 2026-11-07 (TEST only)

Phone-free school notices and school-scoped moderation on TEST. Migrations `0033_day7_school_notices.sql`, `0034_day7_school_notice_ambiguity.sql`. Live suite `npm run test:school-notice:live`: **6/6** pass. Raw: `docs/evidence/TASK_7_1_SCHOOL_NOTICE_LIVE_RAW.txt`. Allowlist after: `107` public / `63` authenticated / `28` internal. Participants generate/get/list notices with year levels + date + collector display name only; moderator queue and withdraw; School B denied School A; direct DML denied; append-only access logs; pg_catalog paths. DEV not migrated. Tasks 7.2–7.4 and Day 8 not started.

## Task 7.2 — 2026-11-07 (TEST only)

Outbound email relay queue, masking, and delivery policy on TEST. Migrations `0035_day7_email_relay_queue.sql`, `0036_day7_email_relay_policy_grants.sql`. Live suite `npm run test:email-relay:live`: **6/6** pass. Raw: `docs/evidence/TASK_7_2_EMAIL_RELAY_LIVE_RAW.txt`. Allowlist after: `120` public / `68` authenticated / `36` internal. Masked recipient only on authenticated paths; raw email only via service-role claim; `handover_reminder` blocked; School B denied School A; server module `server/admin/email-relay.ts` stays out of client bundles. DEV not migrated. Tasks 7.3–7.4 and Day 8 not started.

## Task 7.3 — 2026-11-07 (TEST only)

90-day disclosure / access-log / departure-check retention purge on TEST. Migrations `0037_day7_retention_purge.sql`, `0038_day7_retention_purge_coalesce.sql`. Live suite `npm run test:retention-purge:live`: **5/5** pass. Raw: `docs/evidence/TASK_7_3_RETENTION_PURGE_LIVE_RAW.txt`. Allowlist after: `125` public / `69` authenticated / `40` internal. Purges mobiles, backups, consents, contact notifications, notice access logs/notices, departure checks, and email-relay rows for ended swaps ≥90d; preserves ledger, trust events, children, confirmations, cancellation events. Authenticated and School B denied purge; ordinary deletes still raise 55000 without purge GUC. DEV not migrated. Task 7.4 and Day 8 not started.

## Task 7.4 — 2026-11-07 (TEST only)

Running-late notice store and late trust penalties on TEST. Migration `0039_day7_running_late_notices.sql`. Live suite `npm run test:running-late:live`: **6/6** pass. Raw: `docs/evidence/TASK_7_4_RUNNING_LATE_LIVE_RAW.txt`. Allowlist after: `132` public / `72` authenticated / `44` internal. Helper posts before requester pickup window start; partner read; after-window post denied (`22023`); 15+ minute late `pickup_done` posts −5 without notice or −2 with prior notice; School B denied School A; direct DML denied; no amount/price/currency/location columns. DEV not migrated. Day 8 not started.

## Day 7 wrap-up — 2026-11-07 (TEST only)

Full `npm run verify` on TEST exit **0**. TypeScript and ESLint clean. Unit **47/47**. Allowlist `Function allowlist verified: 132 public functions, 72 authenticated entries, 44 internal declarations.` RLS config `tests/rls/**/*.test.ts`: **376/376** across 15 files (migration-contract, live-rls incl. C3/G1, rpc-smoke, invitation/g3, ledger-live, contact-live, handover-live, trust-live, trust-deltas-live, trust-holds-live, school-notice-live, email-relay-live, retention-purge-live, running-late-live). Raw: `docs/evidence/DAY7_WRAPUP_VERIFY_RAW.txt`. No new migration in this wrap-up. Wrap-up also extended rpc-smoke and contact allowlist leak-scan maps for Day 7 RPCs and stabilised school-notice access-log order assertion. DEV not migrated. Aggregate Day 7 `[x]`. Aggregate Day 6 `[x]`. Aggregate Day 5 remains `[~]` for Day 8 handover reminder delivery. Day 8 authorised by **TASK DAY 8**.

## Day 8 start — 2026-11-07 (TEST only)

**TASK DAY 8** opened work on branch `wip/day8-community` from the Day 7 wrap tip. Scope (from `docs/CONTEXT.md` / Day 5 residual / authorizing task): school-scoped discussion community (threads, replies, own-school moderation) and handover reminder **delivery** with live eligibility recheck through the Day 7 email-relay path. **Day 9 is not started.**

Baseline milestone verification reused the green Day 7 wrap-up gate and re-ran `npm run verify` on TEST at Day 8 start: exit **0**; unit **47/47**; allowlist `132/72/44`; RLS **376/376**. Raw: `docs/evidence/DAY8_START_VERIFY_RAW.txt`. No new migration in this start task. Tasks 8.1–8.3 are open; no Day 8 feature SQL or live suite exists yet at branch open.

## Task 8.1 — school-scoped community discussion — 2026-11-07 (TEST only)

School-scoped discussion threads, posts, comments and likes on TEST. Migration `0040_day8_community_discussion.sql`. Live suite `npm run test:community:live`: **5/5** pass. Raw: `docs/evidence/TASK_8_1_COMMUNITY_LIVE_RAW.txt`. Allowlist after: `145` public / `79` authenticated / `50` internal. Same-school create/list/comment/like; privacy filter denies phones/emails/photos/child full-name phrasing; School B denied School A; direct DML denied; RLS SELECT-only; no amount/price/currency/photo columns. Australian English Community hub UI. DEV not migrated. Tasks 8.2–8.3 and Day 9 not started.

## Task 8.2 — community moderation — 2026-11-07 (TEST only)

Community reporting, auto-hide after three unique reports, and own-school moderator review on TEST. Migrations `0041_day8_community_moderation.sql`, `0042_day8_community_moderation_guards.sql`, `0043_day8_community_moderation_audit_payload.sql`. Live suite `npm run test:community-moderation:live`: **5/5** pass. Raw: `docs/evidence/TASK_8_2_COMMUNITY_MODERATION_LIVE_RAW.txt`. Allowlist after: `155` public / `84` authenticated / `55` internal. Parents report; third unique report auto-hides; moderator restore/remove/hide/queue; parents cannot forge moderator actions; School B denied School A; direct DML denied; no amount/price/currency/photo columns. DEV not migrated. Task 8.3 and Day 9 not started.

## Task 8.3 — handover reminder delivery — 2026-11-07 (TEST only)

Handover reminder delivery onto the email-relay queue after live eligibility recheck on TEST. Migration `0044_day8_handover_reminder_delivery.sql`. Live suite `npm run test:handover-reminder-delivery:live`: **5/5** pass. Raw: `docs/evidence/TASK_8_3_HANDOVER_REMINDER_DELIVERY_LIVE_RAW.txt`. Allowlist after: `160` public / `85` authenticated / `59` internal. Service `deliver_due_handover_reminders` queues `handover_reminder` only when still eligible; completed/cancelled suppressed; authenticated cannot enqueue/claim/send; School B denied School A delivery reads; direct DML denied; no amount/price/currency columns. DEV not migrated. Aggregate Day 8 and Day 5 residual delivery `[x]`. Day 9 not started.

## Day 8 wrap-up — 2026-11-07 (TEST only)

Full `npm run verify` on TEST exit **0**. TypeScript and ESLint clean. Unit **47/47**. Allowlist `Function allowlist verified: 160 public functions, 85 authenticated entries, 59 internal declarations.` RLS config `tests/rls/**/*.test.ts`: **429/429** across 18 files (migration-contract, live-rls incl. C3/G1, rpc-smoke, invitation/g3, ledger-live, contact-live, handover-live, trust-live, trust-deltas-live, trust-holds-live, school-notice-live, email-relay-live, retention-purge-live, running-late-live, community-live, community-moderation-live, handover-reminder-delivery-live). Raw: `docs/evidence/DAY8_WRAPUP_VERIFY_RAW.txt`. No new migration in this wrap-up. Wrap-up also extended the ledger completion-name allowlist for Task 8.3 `list_my_handover_reminder_deliveries` and accepted FK `0A000` alongside guard `55000` for privileged handover truncate denial. DEV not migrated. Aggregate Day 8 `[x]`. Aggregate Day 7 `[x]`. Aggregate Day 6 `[x]`. Aggregate Day 5 `[x]`. Day 9 authorised by **TASK DAY 9**.

## Day 9 start — 2026-11-07 (TEST only)

**TASK DAY 9** opened work on branch `wip/day9-listings` from the Day 8 wrap tip. Scope (from `docs/DECISIONS.md` / authorizing task): school-scoped free giveaway and second-hand listing board with no price/amount/currency, admin-editable restricted items, and own-school listing moderation. **Day 10 is not started.**

Baseline milestone verification reused the green Day 8 wrap-up gate and re-ran `npm run verify` on TEST at Day 9 start: exit **0**; unit **47/47**; allowlist `160/85/59`; RLS **429/429**. Raw: `docs/evidence/DAY9_START_VERIFY_RAW.txt`. No new migration in this start task. Tasks 9.1–9.3 are open; no Day 9 feature SQL or live suite exists yet at branch open.

## Task 9.1 — school-scoped free listings — 2026-11-07 (TEST only)

School-scoped free giveaway/lending listings with restricted-item enforcement, search/filter and enquiries on TEST. Migrations `0045_day9_item_listings.sql`, `0046_day9_listing_audit_payload.sql`. Live suite `npm run test:listings:live`: **5/5** pass. Raw: `docs/evidence/TASK_9_1_LISTINGS_LIVE_RAW.txt`. Allowlist after: `174` public / `91` authenticated / `67` internal. Same-school create/search/filter/get/enquiry; free-only `display_offer_label`; restricted car seats/cots/bassinets/bunk beds/baby walkers/recalled items rejected; School B denied School A; direct DML denied; RLS SELECT-only; no amount/price/currency/payment/photo columns. DEV not migrated. Tasks 9.2–9.3 not started.

## Task 9.2 — listing status, withdrawal, and moderation — 2026-11-07 (TEST only)

Listing collected/fulfilled/withdraw author transitions, reporting with auto-hide, and own-school moderator review on TEST. Migration `0047_day9_listing_status_moderation.sql`. Live suite `npm run test:listing-moderation:live`: **4/4** pass. Raw: `docs/evidence/TASK_9_2_LISTING_MODERATION_LIVE_RAW.txt`. Allowlist after: `187` public / `99` authenticated / `72` internal. Author status closes search visibility; third unique report auto-hides; moderator restore/remove/hide/queue; parents cannot forge moderator actions; School B denied School A mutations and sees empty foreign queue/search; direct DML denied; no amount/price/currency/payment/photo columns. DEV not migrated. Task 9.3 not started.

## Task 9.3 — restricted items admin edit — 2026-11-07 (TEST only)

Global administrator create/update/soft-deactivate of restricted listing catalogue on TEST. Migration `0048_day9_restricted_items_admin.sql`. Live suite `npm run test:restricted-items-admin:live`: **3/3** pass. Raw: `docs/evidence/TASK_9_3_RESTRICTED_ITEMS_ADMIN_LIVE_RAW.txt`. Allowlist after: `193` public / `102` authenticated / `75` internal. Admin create blocks listings matching new terms; deactivate lifts enforcement; parents and School A/B moderators denied mutate/list-all; RLS retained; no amount/price/currency/payment/photo columns. DEV not migrated.

## Day 9 wrap-up — 2026-11-07 (TEST only)

Full `npm run verify` on TEST exit **0**. TypeScript and ESLint clean. Unit **47/47**. Allowlist `Function allowlist verified: 193 public functions, 102 authenticated entries, 75 internal declarations.` RLS config `tests/rls/**/*.test.ts`: **482/482** across 21 files (prior Day 8 suites plus listings-live, listing-moderation-live, restricted-items-admin-live). Raw: `docs/evidence/DAY9_WRAPUP_VERIFY_RAW.txt`. Migrations `0045`–`0048` on TEST. DEV not migrated. Aggregate Day 9 `[x]`. Aggregate Day 8 `[x]`. Aggregate Day 7 `[x]`. Aggregate Day 6 `[x]`. Aggregate Day 5 `[x]`. Day 10 waits for **`GO DAY 10`**.

## G4 evidence — 2026-11-06 (TEST only)

Day 4 stays `[~]`. No new migration was added. TEST already had `0001`–`0023` applied; `npm run db:migrate:test` skipped every file. DEV was not migrated. Allowlist diff is none: `Function allowlist verified: 69 public functions, 45 authenticated entries, 8 internal declarations.`

The first `npm run verify` stopped at TypeScript `TS7053` in `tests/rls/live-rls.test.ts` because a `QueryResult` was indexed with `[0]`. The assertion was changed to `.rows[0]`. Raw stop: `docs/evidence/G4_VERIFY_TYPECHECK_RAW.txt`. That edit does not reach the expired-invitation insert, which still fails later.

The completed `npm run verify` exit code is **1**. A same-day repeat at 21:21:53 reproduced it: TypeScript passed, ESLint passed, and unit tests passed **47/47**. The full RLS config (`tests/rls/**/*.test.ts`) passed **249** and failed **3** (**252**). Raw command output: `docs/evidence/G4_VERIFY_RAW.txt`. The verbose full live harness at 21:25:11 repeated **249 pass / 3 fail**: `docs/evidence/G4_LIVE_HARNESS_RAW.txt`. Verbose unit names: `docs/evidence/G4_UNIT_VERBOSE_RAW.txt`. Passing tests print one runner line each. Vitest does not print a separate line for each passing `expect`. The three failing expects are in the raw files.

Failed tests, both runs:

- `C3 expires only the caller own expired proposal with privileged read-back`: fixture rows `...011` and `...012` read back `expired`; the test expected `proposed`.
- `G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors`: the expired-invitation insert violates `school_invitations_check` (SQLSTATE 23514) because `expires_at` is earlier than `sent_at`.
- `allAllowlistedRPCResponseLeakScan`: `create_availability_pattern` returned unexpected SQLSTATE `42702`, and `update_availability_pattern` returned unexpected SQLSTATE `23503`. The same scan still records `accept_current_consent` and `refresh_my_availability_instances` as known legacy `42702`, which the test does not treat as this failure.

Isolated G3 cases inside the same harness passed, including token length and hash-only storage, expiry, use limit, five-attempt rate limit, C2 school scope and cross-school household claim denial, caller-only proposal expiry, and C4 actor/school attribution with anon denial. Those passes do not clear the legacy C3 or G1 failures and do not mark Day 4 `[x]`.
