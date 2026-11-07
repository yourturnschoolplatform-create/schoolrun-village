# Task 10.3 — admin console moderation (mutations + read models)

Date: 2026-11-07. Branch: `wip/day10-admin-notifications`. SQL targets **TEST only**. DEV unchanged. No secrets.

Source commit hash is in the handoff (`git log -1 --format=%H`).

## 1. Draft → production adaptations

| Draft | Actual |
|---|---|
| `yourturn.admin_audit_logs` + `admin_email` | Existing append-only `public.audit_logs` + `actor_id` |
| `yourturn.is_admin()` email hardcode | Existing `public.is_admin()` via `role_assignments` |
| `yourturn.memberships` / `safety_hold_status` | `profiles.admin_suspended` + `trust_safety_holds` via `resolve_safety_hold` |
| `search_path = pg_catalog, public` | `pg_catalog` only |
| Free-text `p_reason` | Validated `reason_code` (`^[a-z][a-z0-9_]{2,60}$`) in safe audit payload |

## 2. What works (source)

Migration [`0051_day10_admin_moderation.sql`](../db/migrations/0051_day10_admin_moderation.sql):

| RPC | Role | Effect |
|---|---|---|
| `admin_suspend_user` / `admin_unsuspend_user` | global admin | toggles `profiles.admin_suspended` + `admin.user_*` audit |
| `admin_resolve_safety_hold` | global admin only | finds active hold for subject; delegates to `resolve_safety_hold`; extra `admin.safety_hold_resolved` audit |
| `list_admin_safety_holds` | global admin | active holds (ids/status/timestamps only) |
| `list_admin_suspended_users` | global admin | suspended profile ids (no display_name/email) |
| `list_admin_audit_actions` | global admin | recent `admin.*` audit rows |

School moderators keep school-scoped `place_safety_hold` / `resolve_safety_hold` but **cannot** call admin console RPCs.

## 3. Allowlist diff

| Section | Names | Count delta |
|---|---|---|
| authenticated | list_admin_* (3), admin_suspend_user, admin_unsuspend_user, admin_resolve_safety_hold | +6 → **111** |
| internal | admin_require, admin_reason_code_is_valid | +2 → **84** |

Expected public after migrate: prior Day 10 expected + 8 ≈ **211** (not live-verified in agent shell).

## 4. Evidence

Offline contract / unit / typecheck / lint captured under `docs/evidence/TASK_10_3_*` after the verification run in this task. Live migrate may still report `ENOTFOUND` in the agent environment; the user's Cursor terminal previously reached TEST successfully — re-run `npm run test:admin-moderation:live` there before marking `[x]`.

## 5. Guardrail risks

- Global admin can suspend any profile except self; abuse is an operator-trust risk, not an RLS gap.
- `admin_resolve_safety_hold` resolves the latest active hold for a subject only.
- Audit payloads never carry free-form reason prose or emails.

## 6. Stop

Day 10 tasks 10.1–10.3 are source-complete but remain `[~]` until live evidence. **Do not start Day 11** until **`GO DAY 11`**.
