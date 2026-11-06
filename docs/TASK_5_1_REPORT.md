# Task 5.1 — trips-owed ledger report

Date: 2026-11-03. Scope: ledger only. SQL applied to the separate synthetic **TEST** project, not DEV. No secrets are included in this report or its evidence files.

The source commit hash is provided in the task handoff and is available with `git log -1 --format=%H`. G6 history is preserved. Source checkpoint storage is separate from database migration and publication.

## 1. What works

Migration [`0018_day5_trip_count_ledger.sql`](../db/migrations/0018_day5_trip_count_ledger.sql) adds one RLS-protected table and three functions.

An accepted leg with a trusted `swap_legs.completed_at` creates exactly one +1 entry: `from_membership` is the recipient/requester who owes a trip, and `to_membership` is the provider/helper. The unique `swap_leg_id`, source-validation trigger and same-school composite foreign keys prevent duplicates, different-pair inserts and transfers. Repeating an unchanged completion does not add another entry. Completed source identity/timestamp cannot be rewritten.

The ledger stores nine columns only: `id`, `school_id`, `from_membership`, `to_membership`, `swap_leg_id`, integer `trip_count_delta`, `created_at`, `expires_at`, `reminder_due_at`. There are no price, amount, currency, monetary-balance or third-party/transfer fields. Client INSERT/UPDATE/DELETE/TRUNCATE are revoked. Raising ALWAYS row and TRUNCATE triggers enforce append-only behaviour even when a privileged DML caller has the corresponding grants.

`get_my_ledger()` takes no arguments and derives its caller from `auth.uid()` and their oldest fully onboarded verified school membership. It returns:

- `entries`: only that membership's pair entries, including immutable expired history and a computed `is_expired` flag.
- `partners`: `partner_membership`, nonnegative `trips_i_owe`, and nonnegative `trips_owed_to_me`; reverse trips offset within the same pair only.

The week-six reminder deadline is exactly 1,008 elapsed hours after completion; expiry is exactly 1,344 elapsed hours. Using hours keeps 42/56-day elapsed durations stable across DST. Expired entries remain stored but do not affect netting. Reading expiry issues no audit, penalty, score update or notification.

**Integration boundary:** Task 5.1 adds the trusted completion marker, not a public one-parent completion RPC or handover UI. In tests, completion is explicitly a privileged synthetic fixture action; RLS/write-denial assertions are non-privileged. A later two-confirmation handover must set this marker transactionally. Reminder delivery is not implemented; this task supplies `reminder_due_at` only.

## 2. Tables and RLS

| Table | Change | RLS | Application access |
|---|---|---|---|
| `swap_ledger_entries` | New immutable pair ledger | Enabled; 1 SELECT policy | Fully onboarded verified pair participants only; SELECT only |
| `swap_legs` | Adds nullable trusted `completed_at` and completion trigger | Existing RLS retained | Existing participant SELECT; no client completion write |

Anonymous callers have no ledger-table privilege and no EXECUTE on any of the three new functions. School B parent and moderator cannot read School A entries through direct authenticated SELECT or the RPC. A same-school nonparticipant also receives no entries. Pending, rejected, suspended, no-membership and stale-onboarding callers are blocked.

Raw catalogue rows: [`TASK_5_1_CATALOG_RAW.json`](evidence/TASK_5_1_CATALOG_RAW.json). Its all-public-column monetary-name query returned `[]`. The live test independently checks all public column names through `pg_catalog`, including inaccessible tables, and checks the exact ledger column set.

## 3. Function allowlist diff

| Section | New function | Derivation and school restriction | anon EXECUTE | authenticated EXECUTE | search_path |
|---|---|---|---|---|---|
| `authenticated` | `get_my_ledger()` | `auth.uid()`, no identity arguments, own membership pair in one verified school | false | true | `pg_catalog` |
| `internal` | `guard_swap_ledger_entry()` | Trigger NEW/OLD; leg and both membership schools/pair must agree | false | false | `pg_catalog` |
| `internal` | `record_completed_swap_leg()` | Trusted accepted leg; actual instance owners and verified same-school memberships | false | false | `pg_catalog` |

All three use schema-qualified application calls and explicit revokes/grants. The allowlist checker now rejects internal functions executable by authenticated and checks the exact declared path for these new functions. The existing checks for any anonymous public-function EXECUTE, unlisted authenticated EXECUTE and missing SECURITY DEFINER paths remain in force. The RPC smoke suite also calls `get_my_ledger()`.

## 4. Raw verification evidence

### Ledger-only live suite — PASS

[`TASK_5_1_LEDGER_LIVE_RAW.txt`](evidence/TASK_5_1_LEDGER_LIVE_RAW.txt) contains the complete, unedited verbose runner output: **27 passed (27)**. Every test name is present. All protected assertions verify `authenticated`, non-superuser, non-BYPASSRLS, row security enabled and the expected synthetic JWT subject before querying.

Covered cases include owner update/delete denial and unchanged read-back; raw client insert/truncate denial; School B parent/moderator isolation with their own pair as a positive control; same-school nonparticipant denial; source +1 direction and exactly-once completion; silent expired-history exclusion; per-partner offsets; UTC/DST deadlines; invalid pair rejection; immutable source; actual anonymous new-function calls denied; RLS/privilege/allowlist/catalogue assertions.

### Full `npm run verify` — FAIL, existing failures retained

Complete output: [`TASK_5_1_VERIFY_RAW.txt`](evidence/TASK_5_1_VERIFY_RAW.txt).

| Stage | Result |
|---|---|
| TypeScript | PASS |
| ESLint | PASS |
| Unit suite | 31/31 PASS |
| Static RLS contract suite | 40/40 PASS |
| Function allowlist | PASS: 57 public functions, 39 authenticated entries, 2 internal declarations |
| RPC resolution smoke | 1/1 PASS |
| New ledger live suite | 27/27 PASS (also passed independently) |
| Legacy live suite | 15/17 PASS; C3 and G1 FAIL |
| Combined RLS tests | 83 PASS / 2 FAIL (85) |
| Overall exit code | **1** |

The new ledger has no failing case in the completed runs. The full gate is **not green** and is not represented as green. No legacy assertion was removed, skipped or weakened.

Build and credential-boundary checks passed: [`TASK_5_1_BUILD_RAW.txt`](evidence/TASK_5_1_BUILD_RAW.txt).

### Fixture cleanup — PASS

Every new ledger case uses random synthetic IDs within a single transaction and unconditional afterEach ROLLBACK, including setup failure. A separate post-run read-only TEST query returned zero leftover ledger-fixture schools, users and entries: [`TASK_5_1_CLEANUP_RAW.json`](evidence/TASK_5_1_CLEANUP_RAW.json). This claim is limited to the ledger fixture; the legacy suite still uses its historical persisted fixtures.

## 5. Bugs by severity

- **High — existing full-gate blockers:** `C3 expires only the caller own expired proposal with privileged read-back` still observes two rows as expired when expected proposed; persisted fixture state is not reset by its ON CONFLICT setup. This failure is not proof of correct expiry behaviour for clean unrelated-party inputs. `G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors` still fails inserting an expired fixture against `school_invitations_check`. Both are outside Task 5.1 and remain open.
- **Medium — existing application evidence gaps:** full handover, accepted-only child reveal/concurrent-match acceptance and other previously documented acceptance coverage are not supplied by this ledger task. No production-readiness claim is made.
- **Task 5.1:** no new known defect identified in its 27 passing live cases and independent read-only SQL review. This is bounded evidence, not a claim that undiscovered defects are impossible.

## 6. Guardrail risks and limits

No new child, contact, location, monetary or trust-score disclosure is introduced. Ledger data is membership/swap IDs and trip-count/timestamp facts only. An expiry marker is computed, not a mutable stored boolean, to preserve append-only history. Only a trusted server/DB workflow may write completion; exposing a unilateral completion endpoint later would violate the handover boundary.

As with any Postgres trigger, a sufficiently privileged database owner can alter/drop database objects or disable triggers via DDL. The tested guarantee covers normal DML with raising triggers enabled, including privileged UPDATE/DELETE/TRUNCATE. It is not a claim of protection from a malicious database owner changing the schema.

DEV has not received 0018 and cannot yet serve the new RPC. No publication or new reminder job was requested/performed. The source checkpoint does not change that DB state. The broader Day 5 tracker remains open; only Task 5.1 is `[x]`, with passing live names cited.

## 7. Exact verification steps

1. Use the separate synthetic TEST project's protected `SUPABASE_RLS_TEST_DATABASE_URL`; do not point the fixture suite at DEV.
2. Run `npm run test:ledger:live`. It applies missing TEST migrations, checks the allowlist and runs all 27 verbose ledger cases; fixtures roll back.
3. Run `npm run verify` for the full gate. Expect the two documented legacy failures until those are separately repaired; do not skip them to make the gate green.
4. For a signed-in participant, call `get_my_ledger()` through Supabase with their actual authenticated JWT, not the service-role key. No caller/school ID can be passed. Expected body is `{entries: [...], partners: [...]}`; nonparticipants receive only their own pairs or empty arrays.
5. Compare the exact columns, policy and privileges to the retained raw catalogue JSON. Check expired entries have `is_expired: true` in the RPC while remaining present in history and absent from `partners` netting.
6. There is no new click-through screen in this backend-only task, no client completion command, and no claim of a full handover flow.
