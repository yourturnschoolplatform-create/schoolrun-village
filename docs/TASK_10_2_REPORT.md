# Task 10.2 — system event notifications (handover / swap / trust)

Date: 2026-11-07. Branch: `wip/day10-admin-notifications`. New SQL targets **TEST only**. DEV unchanged. No secrets in this report.

The source commit hash is in the handoff (`git log -1 --format=%H`).

## 1. What works (source)

Migration [`0050_day10_system_event_notifications.sql`](../db/migrations/0050_day10_system_event_notifications.sql) adapts the Task 10.2 draft to the live schema:

- Schema is `public` (not `yourturn.*` tables/RPCs).
- Legs use `helper_id` / `requester_id` (user UUIDs), not membership columns.
- Metadata keys are only `entity_type`, `entity_id`, `reason_code`, `outcome`, `source` (not `leg_id`).
- `search_path = pg_catalog` only (no `, public`).
- Enqueue goes through `public.enqueue_user_notification` + GUC gate from 0049.

Wiring:

| Event | Mechanism | Kind(s) | Recipients |
|---|---|---|---|
| Pickup / arrival confirmation | AFTER INSERT trigger on `swap_leg_confirmations` | `handover_update` | Counterparty on the leg |
| Leg `completed_at` first set | AFTER UPDATE trigger on `swap_legs` | `handover_completed` | Helper + requester |
| Swap proposed | `propose_reciprocal_swap` | `swap_proposed` | Recipient |
| Accept / decline / withdraw | `transition_swap_proposal` | `swap_accepted` / `swap_declined` / `swap_withdrawn` | Counterparty |
| Safety hold place / resolve | `place_safety_hold` / `resolve_safety_hold` | `safety_hold` | Subject |
| Trust score delta applied | `apply_trust_score_delta` | `trust_update` | Subject (no numeric score in copy) |

Idempotency: `notify_user_event_once` skips when the same user/kind/`entity_id`/`reason_code` already exists.

Offline: typecheck PASS; lint PASS; unit **47/47**; migration-contract **87/87**.

## 2. Allowlist diff

| Section | Function | auth EXECUTE |
|---|---|---|
| internal | `notify_user_event_once` | false |
| internal | `notify_handover_confirmation` | false |
| internal | `notify_handover_completion` | false |

Source counts after edit: authenticated **105**, internal **82** (was 79 after 10.1). Expected public after migrate: **203** (200 + 3); not live-verified.

## 3. Raw verification evidence

| Check | Result | Evidence |
|---|---|---|
| Typecheck / lint | PASS | `TASK_10_2_TYPECHECK_RAW.txt`, `TASK_10_2_LINT_RAW.txt` |
| Unit | 47/47 PASS | `TASK_10_2_UNIT_RAW.txt` |
| Migration contract | 87/87 PASS | `TASK_10_2_CONTRACT_RAW.txt` |
| `db:migrate:test` | FAIL `ENOTFOUND` | `TASK_10_2_MIGRATE_RAW.txt` |
| `test:notification-events:live` | FAIL (migrate) | `TASK_10_2_NOTIFICATION_EVENTS_LIVE_RAW.txt` |

## 4. Bugs / remains

- **High — TEST DB unreachable:** same agent `ENOTFOUND` as Task 10.1. Re-run migrate + `npm run test:notification-events:live` (and 10.1 live) once DNS is reachable. Do not mark Task 10.2 `[x]` until live names pass.
- Admin console read models originally listed as TODO 10.2 are deferred into Task 10.3.

## 5. Guardrail risks

- Trust inbox text never includes scores; numeric history stays in `trust_score_events`.
- Completion trigger notifies both parties; confirmation trigger notifies only the counterparty.
- Trigger/helpers have no authenticated EXECUTE.

## 6. Stop

Task 10.3 / Day 11 not started.
