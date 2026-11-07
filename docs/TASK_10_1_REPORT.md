# Task 10.1 — user notifications ledger (schema / RLS / RPC slice)

Date: 2026-11-07. Branch: `wip/day10-admin-notifications`. New SQL and synthetic fixtures target **TEST only**. DEV SQL/publication unchanged. No secrets in this report or evidence files.

The source commit hash is in the handoff (`git log -1 --format=%H`).

## 1. What works (source)

Migration [`0049_day10_user_notifications.sql`](../db/migrations/0049_day10_user_notifications.sql) adds:

- Table `public.notifications`: `user_id`, `school_id`, `kind` (handover_reminder / contact_consent_revoked / listing_enquiry / listing_status / community_moderation / swap_accepted / system), `title`, `body`, `is_read`, `metadata` (allowlisted string keys only), `created_at`, `read_at`.
- RLS: authenticated SELECT and UPDATE own rows only (`user_id = auth.uid()`). No INSERT/DELETE grants. ALWAYS triggers block client INSERT without GUC `yourturn.notification_enqueue=1`, and block DELETE/TRUNCATE and non-read-field UPDATEs.
- RPCs (all `search_path=pg_catalog`):
  - `enqueue_user_notification` — internal/system only (EXECUTE revoked from anon/authenticated).
  - `list_my_notifications(unread_only)` — owner list.
  - `mark_notification_read(id)` — owner mark one.
  - `mark_all_notifications_read()` — owner mark all unread; returns `{ outcome, marked_count }`.
- No amount/price/currency/payment/phone/photo/nickname/live-location columns or payload keys.

Allowlist: +3 authenticated, +4 internal. Source file counts after edit: authenticated **105**, internal **79** (Day 9 wrap was 102 / 75). Expected public function count after migrate: **200** (193 + 7); not verified live.

Live suite [`tests/rls/notifications-live.test.ts`](../tests/rls/notifications-live.test.ts) and script `npm run test:notifications:live` are wired; smoke/contact/migration-contract updated.

Offline gates: typecheck PASS; lint PASS; unit **47/47**; migration-contract **86/86**.

## 2. Tables and RLS

| Table | RLS | Policies | Client privileges |
|---|---|---|---|
| `notifications` | enabled | SELECT own; UPDATE own | SELECT, UPDATE only |

## 3. Function allowlist diff

| Section | Function | auth EXECUTE | search_path |
|---|---|---|---|
| authenticated | `list_my_notifications` | true | `pg_catalog` |
| authenticated | `mark_notification_read` | true | `pg_catalog` |
| authenticated | `mark_all_notifications_read` | true | `pg_catalog` |
| internal | `notification_metadata_is_safe` | false | `pg_catalog` |
| internal | `guard_notifications` | false | `pg_catalog` |
| internal | `notification_json` | false | `pg_catalog` |
| internal | `enqueue_user_notification` | false | `pg_catalog` |

## 4. Raw verification evidence

| Check | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `docs/evidence/TASK_10_1_TYPECHECK_RAW.txt` |
| Unit | 47/47 PASS | `docs/evidence/TASK_10_1_UNIT_RAW.txt` |
| Migration contract | 86/86 PASS | `docs/evidence/TASK_10_1_CONTRACT_RAW.txt` |
| `db:migrate:test` | FAIL `ENOTFOUND` | `docs/evidence/TASK_10_1_MIGRATE_RAW.txt` |
| `test:notifications:live` | FAIL (migrate) | `docs/evidence/TASK_10_1_NOTIFICATIONS_LIVE_RAW.txt` |
| Live allowlist verify | not run | blocked by migrate |

## 5. Bugs / remains

- **High — TEST DB unreachable in agent shell:** `SUPABASE_RLS_TEST_DATABASE_URL` resolves with HOST_LEN=19 and DNS `ENOTFOUND`. Migration `0049` and live suite therefore not applied/proven on TEST. Re-run `npm run test:notifications:live` (then full verify) once a reachable TEST URL is in the environment. Do not mark Task 10.1 `[x]` until live names pass.
- **Scope not in this slice:** notification preference storage; due-event delivery orchestration into this inbox (beyond the system enqueue RPC).

## 6. Guardrail risks

- Privileged callers who can set `yourturn.notification_enqueue` or run as table owner can still insert; ordinary authenticated clients cannot.
- Owner UPDATE policy exists so mark-read can work under RLS; the guard restricts updates to the unread→read transition only.
- Metadata and body text refuse phones/emails via existing community text checks; clients must not treat inbox text as a contact channel.

## 7. Stop

Task 10.2 / 10.3 / Day 11 not started. Wait for further authorisation after live evidence or next task instruction.
