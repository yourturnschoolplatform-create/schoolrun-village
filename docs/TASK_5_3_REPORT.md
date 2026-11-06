# Task 5.3 — two-step handover

## Scope and environment

This increment implements two confirmations, immutable facts, completion-linked ledger/analytics and overdue missing-confirmation **records**. New SQL, synthetic fixtures and native scheduling target the separate TEST project only. It does not apply migrations or install jobs on DEV, publish the app, send reminders, implement school notices or begin another task. Source checkpoint storage is separate from DB deployment. The final commit hash is reported in the handoff, not embedded in its own commit.

## What works in the implementation

The provider records **Pickup done** through `confirm_pickup_done(leg_uuid)`; only the recipient records **Child arrived safely** through `confirm_child_arrived(leg_uuid)`. Caller membership, school, role and timestamps are derived server-side. Either order is accepted. The first fact leaves the leg incomplete; the second atomically completes it, posts Task 5.1's one recipient-to-provider +1 ledger entry and records `first_trip_completed` once per participant. Each actor is projected from their own immutable, auth.uid()-derived confirmation. Repeated taps preserve original timestamps and do not repeat ledger or analytics rows.

Expected arrival defaults to the recipient's requested window end in the school timezone; it is not a live ETA. It and source participant/instance identity freeze after the first confirmation. Exactly one missing confirmation becomes eligible at expected arrival +30 elapsed minutes. A due first tap or participant refresh creates the record immediately if eligible; a native TEST cron sweep runs every minute, so an inactive-app record can appear up to roughly one scan interval after the threshold. Zero/both confirmations, completed legs and nonaccepted/cancelled swaps do not enqueue. Reminder history is retained after completion/cancellation; delivery must recheck current state on Day 8.

The accepted-swap UI includes role-specific buttons, acknowledgement timestamps, incomplete/completed states and manual refresh. JWT HTTP wrappers use RLS and no-store; accept only the leg UUID and never accept actor, school, timestamp or completion inputs. Real-login browser acceptance is not claimed by database and mock HTTP tests.

## Tables, grants and RLS

| New application table | RLS | Authenticated permissions | Read scope |
| --- | --- | --- | --- |
| `public.swap_leg_confirmations` | Enabled; one SELECT policy | SELECT only | Active-school participants in that source leg |
| `public.swap_leg_reminders` | Enabled; one SELECT policy | SELECT only | Active-school participants in that source leg |

Both tables reject direct client writes and have raising immutable UPDATE/DELETE/TRUNCATE triggers. Role-specific memberships and source school are checked before insert. The existing `swap_legs` gains `expected_arrival_at` and an immutable-source guard; its browser DML remains revoked. The ledger guard remains in force. `0020` changes the completion timestamp upper bound from statement start to actual server clock, avoiding false future-time rejection after lock waits, without changing source/pair/integer/expiry validation.

All TEST public/private/cron catalogue rows, policies, new columns and public-function privileges are retained in `evidence/TASK_5_3_CATALOG_RAW.json`. There are 33 public application tables, one private mobile table and two native cron metadata tables; all 36 have RLS. There are 69 public functions, zero anonymous-executable functions, and zero money-like public/private columns in the catalogue search. The two vendor cron metadata tables have inherited table ACLs but no anon/authenticated schema USAGE; their ownership and policies are preserved. Actual denial is tested separately from metadata inspection.

## SQL and allowlist changes

- `db/migrations/0020_day5_two_step_handover.sql`: confirmations/reminders, source timestamps/guards, RPCs, service sweep, completion analytics, clock-safe ledger integration.
- `db/migrations/0021_day5_handover_analytics_lock_order.sql`: deterministic actor-ID ordering before unique-event conflict handling.
- `scripts/install-handover-reminders-test.ts`: explicit TEST-only native cron registration; no runtime database URL access and no DEV installer path.

| Allowlist change | Caller derivation and school check | EXECUTE |
| --- | --- | --- |
| `confirm_pickup_done` | auth.uid() → active provider membership in accepted source school | authenticated |
| `confirm_child_arrived` | auth.uid() → active recipient membership in accepted source school | authenticated |
| `refresh_my_handover_reminders` | auth.uid() → own active-school participant legs, no arguments | authenticated |
| `record_leg_confirmation` | Private wrapper only; fixed role kind; source membership | No anon/authenticated |
| `maybe_record_handover_reminder` | Private scoped wrapper/service call; accepted locked leg and missing role | No anon/authenticated |
| `guard_handover_history` | Trigger NEW/OLD; source school/role/fact integrity | No anon/authenticated |
| `enqueue_due_handover_reminders` | Fixed trusted native/service job; server-selected eligible source legs | service_role; no anon/authenticated |

Every new function uses `search_path=pg_catalog`, explicit revokes/grants and schema-qualified application calls. Existing `record_completed_swap_leg` remains an internal, non-browser trigger. The allowlist gate reports 45 authenticated and 8 internal declarations.

## Verification evidence

The dedicated TEST live suite passed **24/24**. Full raw names/output: `docs/evidence/TASK_5_3_LIVE_RAW.txt`. Its authenticated assertions use synthetic JWT subjects and non-superuser `authenticated`; anonymous and cross-school cases are separately exercised. `npm run build` and `npm run check:secrets` passed; raw output is `docs/evidence/TASK_5_3_BUILD_RAW.txt`. The browser API health evidence shows handover calls return 401 without a JWT (`TASK_5_3_HTTP_HEALTH_RAW.json`).

The completed `npm run verify` **failed with exit code 1** and is preserved without edits in `docs/evidence/TASK_5_3_VERIFY_RAW.txt`. TypeScript, ESLint, 47/47 unit tests, 46/46 migration-contract tests, 1/1 allowlist RPC smoke, 27/27 ledger tests, 24/24 handover tests, and all 57 contact tests passed. Full RLS total: **170 passed, 2 failed of 172**. The only failing cases were existing tests in `tests/rls/live-rls.test.ts`:

1. `C3 expires only the caller own expired proposal with privileged read-back` — read-back found the caller's supposedly not-yet-expired row and the other user's row both already `expired`, contrary to the fixture's expected `proposed` state.
2. `G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors` — fixture INSERT was rejected by `school_invitations_check` before the asserted flow.

These Day 4 failures were not weakened or changed in this Task 5.3 run. The TEST migrations were already applied; the full run reported `Skipped ... (already applied)` for `0001`–`0021`, and did not target DEV. Fixtures use synthetic IDs and transaction rollback; privileged setup/read-back, immutable-trigger exercise and service-worker checks are not counted as authenticated RLS proof.

Native schedule evidence: `TASK_5_3_CRON_INSTALL_RAW.json` records its active fixed per-minute SQL. `TASK_5_3_CRON_RUNS_RAW.json` records an observed **succeeded** run. Initial 42501 installation failure is retained in `TASK_5_3_CRON_FIRST_FAILURE_RAW.txt`; it came from trying to ALTER vendor-owned metadata. The installer now preserves that metadata and checks effective schema access; no RLS policy was disabled and no ownership was changed.

## Bugs, limits and guardrail risks

- **High / pre-existing:** the final full verify still fails C3's expiry read-back and G1's expired-invitation fixture CHECK, as detailed above. They remain open; Task 5.3 does not fix them.
- **Medium / fixed hardening:** review identified possible cross-proposal unique-analytics-key deadlock if the same actors were inserted in opposite orders. `0021` orders actor keys deterministically; a static regression enforces it. A reproduced two-session completion race is **not** claimed; existing rollback tests use one connection.
- **Medium / retained from Task 5.2:** outbound email relay transport and scheduled 90-day retention purge are not configured. Existing unrelated `42702` RPC errors remain named in the response-privacy scan, not treated as successful functionality.
- **Deployment boundary:** new handover SQL and the native reminder job are TEST-only. DEV users cannot use the new workflow until its SQL is explicitly deployed. No publication is claimed.
- **Reminder boundary:** records only; no email/push delivery before Day 8. Delivery must suppress resolved/cancelled records. A one-minute polling cadence is not exact-to-the-second scheduling.
- **Privacy boundary:** no new child/contact/location fields, no client event attribution, no free-form analytics, no monetary fields or transfers, and no paywall. Privileged DB owners can change DDL; tests of raising triggers are not a claim of protection against a database owner rewriting schema.
- **Legacy completion boundary:** historical trusted SQL fixtures can set a completion marker for Task 5.1 regression. All application/browser completion paths introduced here require both confirmations. No public bypass command is introduced.

## Exact verification steps

On the TEST project only:

```sh
npm run test:handover:live
npm run verify
npm run build
npm run check:secrets
```

The standalone and aggregate gates must be read independently. To install/reconcile only the TEST reminder-record job, run `npm run handover:reminders:install:test`; this does not enable Day 8 delivery or migrate DEV.

After deliberate SQL deployment to the chosen application environment, the intended UI path is: sign in as approved provider → **Matches** → accepted swap → **Handover for this swap** → **Pickup done**; sign in as its recipient → same card → **Child arrived safely** → both see **Complete** on refresh. Reverse order is valid. One confirmation must remain incomplete. A duplicate tap must preserve timestamps and counts. Use the dedicated synthetic live tests for 29/31-minute timing instead of waiting or changing real trip dates. This click path is an implementation guide, not a claimed real-login screenshot test.
