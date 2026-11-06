# G6 — confirmed stabilisation merge

Date: 2026-11-07 (Australia/Sydney)

## Authorisation and scope

The user confirmed the evidence for G1–G5 and authorised merging `wip/day4-stabilisation` into the main checkpoint. G6 changes documentation and the source merge only: no new application feature, migration, test assertion or database write is performed by this task. **Day 5 is not started by G6.**

The merge SHA is reported in the task handoff (`git rev-list --parents -n 1 main`). Merge acceptance does not convert a failing or absent test to a pass.

## Tracker changes

Day 2, Day 3 and Day 4 retain `[x]` sub-items only for the live-tested outcomes below. Aggregate day/workflow headings remain `[~]` where complete acceptance lacks passing live evidence. Original acceptance clauses are retained.

All test names below are from the existing G4 live suite evidence, not newly executed by G6.

| Day | Exact passing live test name | What may be marked complete |
|---|---|---|
| 2 | `blocks School B parent direct reads of School A school and configuration data` | Those two cross-school read queries |
| 2 | `blocks School B parent direct reads of School A child data` | Tested child-profile read isolation |
| 2 | `allows School B moderator own-school read scope but blocks School A memberships` | Tested membership read boundary |
| 2 | `blocks School B users and moderators from School A-only safety declaration versions` | Tested declaration-version read boundary |
| 2 | `denies direct analytics writes and invite code/hash queries to browser-authenticated users` | Tested direct INSERT/SELECT denial |
| 2 | `denies School B moderator direct membership mutation outside the audited review RPC` | Tested direct membership UPDATE denial |
| 2 | `C1 creates school invitations only for the intended moderator or admin and school scope` | Moderator/admin invitation success and tested parent/cross-school denials |
| 3 | `does not expose household status to a third party or allow public internal expansion RPCs` | Tested household oracle and internal execution restriction |
| 3 | `blocks School B parent and moderator reads of School A calendar, patterns, instances, households and cancellation events` | Only the SELECT combinations asserted in the test |
| 3 | `blocks School B parent and moderator mutation attempts against School A Day 3 data` | Only the mutation attempts asserted in the test |
| 3 | `requires a current school-specific declaration rather than accepting an older global declaration` | Tested stale-declaration denial |
| 4 | `blocks School B parent and moderator reads and writes of School A proposals, legs and blocks` | Proposal/leg/block SELECT isolation; proposal UPDATE and block INSERT denial; no swap-leg write/RPC completeness claim |
| 4 | `C4 derives analytics actor and school from auth.uid and denies anon` | Tested email_verified actor/null school, first_match_viewed actor/membership school, anon first_match_viewed denial |
| 4 | `denies anon execute on every public function and every public table privilege` | Catalogue-inspected effective anon privileges; not individually executing every function |
| 4 | `leaves published trust policy unchanged after authenticated mutation attempt` | Zero-row/error mutation and privileged unchanged read-back |

The additional passing smoke test is `calls every allowlisted RPC without a missing-function or search_path/extension error`. It allows authorisation denials and is not evidence of end-to-end success, correct business inputs or school isolation for every RPC.

## Latest full test-project gate retained as confirmed evidence

### G4 (2026-11-06, TEST only)

- TypeScript and ESLint: passed.
- Unit tests: 47 passed.
- Allowlist: `69 public functions, 45 authenticated entries, 8 internal declarations.`
- Full RLS harness: **249 passed / 3 failed (252)**; overall `npm run verify` exit **1**.
- Raw: `docs/evidence/G4_VERIFY_RAW.txt`, `docs/evidence/G4_LIVE_HARNESS_RAW.txt`.

Three tests remain red in that confirmed G4 gate:

1. `C3 expires only the caller own expired proposal with privileged read-back`: fixture rows `...011` and `...012` read back `expired`; expected `proposed`.
2. `G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors`: expired-invitation fixture INSERT violated `school_invitations_check` (23514).
3. `allAllowlistedRPCResponseLeakScan`: unexpected `create_availability_pattern` 42702 and `update_availability_pattern` 23503.

G6 does not fix, skip, weaken or rerun these tests. Merge approval does not relabel them as passes.

### G5 (2026-11-07, DEV)

Preflight: project-reference match `yes`, pooler host `yes`, read-only connection `success`. `npm run db:migrate` reconciled `0001`–`0025` (all already applied / skipped). Catalogue: 33 public tables with RLS; `tables_without_rls = 0`; 69 public functions with zero anon EXECUTE; SECURITY DEFINER without fixed search_path `[]`; unqualified-extension query `[]`. Raw: `docs/evidence/G5_2026-11-07_DEV_MIGRATE.txt`, `docs/evidence/G5_2026-11-07_DEV_DATABASE_EVIDENCE.txt`.

Most SECURITY DEFINER functions still use `pg_catalog, public, extensions` or `public`, not `pg_catalog` only. Fixed path is not the same as pg_catalog-only.

DEV live harness: **NOT RUN** — fixture setup commits and `afterAll` only closes the connection. No DEV RLS pass is claimed.

## Remaining acceptance and risks

Day 2: complete email/signup/verification/code/pending/approval/declaration acceptance; invitation-token requirements where G1 remains red.

Day 3: successful bilateral household link, four-week pattern creation/holiday skipping/edit/cancel and confirmed-trip ICS workflow live acceptance.

Day 4: simultaneous accept race; both-direction block exclusion; accepted-partner-only child reveal; unapproved matching denial; every allowed RPC's cross-school boundary; clean C3/G1/scan passing reruns. Aggregate Day 4 stays `[~]`.

The source merge does not certify production readiness. Do not expose real pilot data on the basis of this checkpoint alone. No payment, child-data expansion, live-location feature or safety paywall is introduced.

## Verify the saved merge

1. `git show --no-patch --format=fuller main` and `git rev-list --parents -n 1 main`; the merge must have two parents.
2. Check `TODO.md`: every new `[x]` cites the exact passing live test, and broad incomplete workflows remain `[~]`.
3. Check retained G4 failure evidence and G5 raw catalogue files above. Do not run the fixture-writing harness against DEV.
4. No Day 5 implementation is authorised by G6.
