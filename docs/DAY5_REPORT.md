# YourTurn — reconciliation and Day 5 report

## Scope statement

This is an evidence reconciliation, not a Day 5 delivery. No Day 5 implementation was found in source, migrations, tests, or UI. Day 4 source is also uncommitted: `origin/main` remains at Day 3 checkpoint `b362ef2`.

## 1. Day-by-day tracker status

| Day | Status | Evidence | Remaining / failed evidence |
| --- | --- | --- | --- |
| Day 1 | `[~]` | Typecheck, ESLint, foundation unit tests, static RLS contract, PWA/browser regression, build and health endpoint have passed during the session. | Dev migration has **not** been proven applied; live RLS not proven. |
| Day 2 | `[~]` | Source/UI for sign-up, consent, school verification, moderator workflow; onboarding-boundary and onboarding unit tests passed; 3 Playwright regressions passed. | No successful dev migration or live RLS/API flow. Pending migration and authenticated end-to-end verification. |
| Day 3 | `[~]` | Schedule/ICS source, schedules unit tests, static RLS contract, build and browser regression passed. | Migrations not proven applied; no live RLS or real school-calendar acceptance evidence. |
| Day 4 | `[~]` | Matching source, matching unit/boundary tests (27 total unit tests), 39 static RLS assertions, build, secret-boundary check and 3 Playwright regressions passed. | Day 4 migrations are uncommitted/unapplied; no live RLS/concurrency/API two-user proof. |
| Day 5 | `[ ]` | Scope exists only in `TODO.md` and policy documents. | No ledger, consent, handover, notice migration, endpoint, UI, job, test, or report acceptance evidence. |

### Migration and live-RLS answer

- **Development migrations applied? No evidence; therefore treated as not applied.** Earlier direct migration attempts did not complete successfully.
- **Separate-test-project live RLS run as non-privileged `authenticated` role? No.** The harness is correctly written to use `SET LOCAL ROLE authenticated`, `row_security = on`, synthetic JWT claims, and a superuser assertion, but it did not reach assertions because `db:migrate:test` failed with PostgreSQL `28P01`.
- **`npm run verify` status:** **FAIL** at the isolated test database authentication stage. Before that failure, typecheck, lint and all 27 unit tests passed. No connection string or key was printed.

## 2. Tables and RLS status

The source-level static contract finds `ENABLE ROW LEVEL SECURITY` for all 26 tables below. This is **static source evidence only**, not a live applied-database result.

| # | Table | Source RLS status |
| ---: | --- | --- |
| 1 | `schools` | declared enabled |
| 2 | `school_configs` | declared enabled |
| 3 | `profiles` | declared enabled |
| 4 | `school_memberships` | declared enabled |
| 5 | `role_assignments` | declared enabled |
| 6 | `audit_logs` | declared enabled |
| 7 | `analytics_events` | declared enabled |
| 8 | `feature_flags` | declared enabled |
| 9 | `trust_policy_versions` | declared enabled |
| 10 | `consent_documents` | declared enabled |
| 11 | `consent_acceptances` | declared enabled |
| 12 | `child_profiles` | declared enabled |
| 13 | `safety_declaration_versions` | declared enabled |
| 14 | `safety_declarations` | declared enabled |
| 15 | `school_invite_codes` | declared enabled |
| 16 | `school_invite_attempts` | declared enabled |
| 17 | `school_invitations` | declared enabled |
| 18 | `household_links` | declared enabled |
| 19 | `household_link_invitations` | declared enabled |
| 20 | `school_calendar_periods` | declared enabled |
| 21 | `availability_patterns` | declared enabled |
| 22 | `availability_instances` | declared enabled |
| 23 | `schedule_cancellation_events` | declared enabled |
| 24 | `match_blocks` | declared enabled |
| 25 | `swap_proposals` | declared enabled |
| 26 | `swap_legs` | declared enabled |

There are **no Day 5 tables** such as `swap_ledger_entries`, contact-consent records, handover records, reminder-job records, or school-notice logs.

## 3. Day 5 standard report

### What works

Nothing in the Day 5 scope is implemented. Day 4 accepted-swap source provides a possible base, but it is not a Day 5 acceptance result.

### Tables and RLS

No Day 5 schema exists; consequently there are no Day 5 RLS policies to verify.

### `npm run verify` output

**Fail:** `typecheck`, `lint`, and **27 unit tests** pass; then `db:migrate:test` fails with safe PostgreSQL error **`28P01`** before live RLS tests run.

### Bugs / gaps by severity

- **Blocker:** Day 5 is unimplemented. The isolated test DB cannot authenticate, so neither existing nor future live RLS proof can run.
- **High:** No append-only pair-specific ledger, expiry/reminder mechanism, consent/revoke behaviour, two-party handover completion, or school notice exists.
- **Medium:** Day 4 remains uncommitted; users running the Day 3 checkpoint will not have Day 4 source.

### Guardrail risks

No Day 5 source means no introduced money/contact/notice data risk. The risk is falsely treating policy text as functionality. Day 5 must keep mobile numbers out of notice text, store no prices/amounts/currency, and make consent versioned, revocable and RLS-scoped.

### Click-through steps

There is no Day 5 click-through. Required future acceptance path is: accepted swap → plain-language mobile consent (or email relay) → pickup confirmation → arrival confirmation → append-only ledger entries visible to each participant → school-notice copy containing only date, year level and collector display name → consent revocation ends the swap.

## 4. Day 5 acceptance-evidence reconciliation

| Requirement | Status | Evidence |
| --- | --- | --- |
| Full trip through both handovers | Not implemented | No handover table/RPC/UI/test. |
| Ledger updates for both sides | Not implemented | No `swap_ledger_entries` table or job. |
| Consent records and revoke ends swap | Not implemented | No consent table/RPC/UI/test. |
| Notice has display name only/no phone | Not implemented | No notice generator or test. |
| Append-only, pair-only, non-transferable counts | Not implemented | No ledger schema/triggers/policies. |
| Eight-week expiry + week-six reminder | Not implemented | No schedule/job or tests. |
| No amount/price/currency data fields | Partially evidenced | Search of `db`, `server`, `src`, `shared`, `scripts`, `tests` finds only policy/comments and the unrelated helper parameter `addDays(date, amount)`; no financial schema/API/UI field exists. |

## 5. Recommendation before Day 6

1. Fix `SUPABASE_RLS_TEST_DATABASE_URL` authentication and run migrations through `0010` against the separate synthetic test project.
2. Apply and verify migrations on the development project before adding Day 5/Day 6 data dependencies.
3. Run the live harness as `authenticated` with RLS enabled; add and pass Day 4 cross-school, block, reservation and child-reveal cases before building the trust engine.
4. Commit the reviewed Day 4 source before relying on it as the base for Day 5.
5. Only then build Day 5 with a migration-first, append-only ledger and explicit consent/handover RLS tests.

Wait for **GO DAY 6** only after deciding whether to repair the migration/test environment first.
