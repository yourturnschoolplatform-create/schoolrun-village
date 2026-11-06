# Task 5.2 — contact consent report

Date: 2026-11-03. New SQL and synthetic fixtures target **TEST only**. DEV SQL/publication are unchanged. The final source commit hash is in the handoff; source saving does not apply SQL to DEV.

## 1. What works

`0019_day5_contact_consents.sql` creates consent snapshots, selected-backup scope and private mobile storage. The only phone disclosure RPC is `get_shared_contact(swap, consenting_membership)`. The caller is always auth.uid(), never a supplied user ID. An accepted swap, current consent, verified same-school reader and owner, and partner-or-selected-backup relationship are required. Owner, unrelated, foreign-school and anonymous reads do not return a number. A chosen backup receives only the specifically consenting owner's number, not the other parent's number by association.

`grant_contact_sharing(swap, number, chosen_backups)` derives the caller's own membership, validates Australian E.164 format and at most two approved same-school backups (or the lower school maximum), and returns metadata only. `consent_version` increases per swap/member; policy version is recorded separately as 1. A new grant supersedes the old immutable snapshot, including its selected-backup list; it is not an explicit withdrawal. Previous and new private number snapshots are never copied into exposed metadata.

`revoke_contact_sharing(swap)` records revoked_at, changes the swap to `cancelled_consent_revoked`, retains accepted_at, appends one `consent_revoked` cancellation event and delivers a fixed phone-free notification to the partner's in-app inbox in the same transaction. Retries preserve timestamps and do not duplicate history. All partner/backup phone access ends immediately, including access governed by the other owner's still-recorded consent, because the swap is no longer accepted. Neither participant can revive it. Completed ledger history is untouched; no trust penalty is scored here.

An existing consenting owner may still withdraw after suspension or stale onboarding; those states do block new grants and phone reads. Matching UI includes an accepted-swap consent form with an explicit version-1 acknowledgement and immediate-cancellation warning. The partner's own inbox refreshes while Matches is open. Numbers are cleared from forms after saving/revoking/unmount, not placed in browser storage/URLs or swap summaries. The dedicated getter is available via JWT API/RPC; there is no new phone directory or recipient-number browsing screen.

**Not fully finished:** email relay is the default policy/metadata, but no outbound relay email transport is configured. No email is claimed sent. Partner notification in this task is in-app, not email/push. The existing 90-day post-swap disclosure/notice log retention policy still lacks a purge job. The broader Task 5.2 remains `[~]` for operational email relay; completed backend sub-items are evidenced separately.

## 2. Tables and RLS — actual TEST catalogue

| Table | RLS | Policies | authenticated access | anonymous access |
|---|---|---:|---|---|
| `public.contact_consents` | enabled | 1 | own metadata SELECT only | none |
| `public.contact_consent_backups` | enabled | 1 | own consent's selections SELECT only | none |
| `public.swap_cancellation_events` | enabled | 1 | same-school swap participants SELECT only | none |
| `public.swap_contact_notifications` | enabled | 1 | intended membership's own inbox SELECT only | none |
| `yourturn_private.mobile_numbers` | enabled | 0 | no schema/table/column privilege or policy | none |

`swap_proposals` retains existing RLS. It adds cancelled_at and a new terminal status; its acceptance constraint preserves accepted_at for accepted and consent-cancelled states. Raw catalogue: [TASK_5_2_CATALOG_RAW.json](evidence/TASK_5_2_CATALOG_RAW.json), including every public table's RLS/policy count and all public function privileges. It shows **31 public tables, zero without RLS; 62 public functions, zero anonymously executable**, plus the separate private table with RLS and zero policies/privileges. No public phone/mobile/money-like columns or view/materialized-view references to the private number table were returned. The only authenticated public functions referencing that table are the metadata-only writer and scoped getter. Runtime response checks supplement the catalogue inspection.

## 3. Allowlist diff and permissions

| Section | Function | Caller and scope | anon | authenticated | search_path |
|---|---|---|---|---|---|
| authenticated | `grant_contact_sharing(uuid,text,uuid[])` | auth.uid(); owning accepted verified same-school participant and validated backup memberships | no | yes | pg_catalog |
| authenticated | `revoke_contact_sharing(uuid)` | auth.uid(); existing consenting swap participant, even if no longer active | no | yes | pg_catalog |
| authenticated | `get_shared_contact(uuid,uuid)` | auth.uid() reader; supplied member identifies consent owner, not caller | no | yes | pg_catalog |
| internal | `guard_contact_history()` | trigger NEW/OLD only; one-way consent transitions and append-only history | no | no | pg_catalog |
| internal | `contact_member_is_active(uuid,uuid)` | scoped definer RPC internal eligibility check; no client identity oracle | no | no | pg_catalog |

All use explicitly qualified application/auth objects and explicit revokes/grants. The allowlist check passes with **62 public functions, 42 authenticated entries and 4 internal declarations**. Existing unlisted/anonymous EXECUTE and missing SECURITY DEFINER path failures remain enforced. The three new RPCs are included in the existing smoke suite.

## 4. Raw test evidence

### Initial full contact run — retained failure

[TASK_5_2_FIRST_LIVE_RAW.txt](evidence/TASK_5_2_FIRST_LIVE_RAW.txt): **56 passed / 1 failed (57)**. The failed new response-leak scan classified errors from legacy RPCs as unexpected; no contact disclosure assertion failed. The original output is not rewritten.

The new privacy scan now records each actual call as success, denial, explicitly named known legacy error, or unexpected error. It still rejects any synthetic-phone output/error outside the narrowly scoped getter, checks every allowlist name was called, and fails on unexpected codes. `P0002` from deliberately unknown invitation/household references is an expected denial. `42702` is classified only for the two specific older RPCs below, never treated as functionality success. No pre-existing test or application RPC was changed to hide them.

[TASK_5_2_TARGETED_SCAN_RAW.txt](evidence/TASK_5_2_TARGETED_SCAN_RAW.txt): the corrected privacy scan **1 passed, 56 filtered/skipped**. All **42 allowlisted functions** were actually called inside rollback savepoints, and the safe name/outcome/SQLSTATE list is logged. All three new contact RPC calls succeeded. This targeted result alone is not described as 57 passing tests; the final full run is recorded separately.

### Final `npm run verify`

Complete output: [TASK_5_2_VERIFY_RAW.txt](evidence/TASK_5_2_VERIFY_RAW.txt).

| Stage | Actual result |
|---|---|
| TypeScript | PASS |
| ESLint | PASS |
| Unit tests | 38/38 PASS, including 7 new HTTP response tests |
| Static RLS contracts | 44/44 PASS |
| Function allowlist | PASS: 62 public functions / 42 authenticated / 4 internal |
| RPC resolution smoke | 1/1 PASS |
| Ledger live regression | 27/27 PASS |
| Contact live suite | **57/57 PASS**, no filtered/skipped cases in this final run |
| Legacy live suite | 15/17 PASS; C3 and G1 FAIL |
| Combined RLS result | **144 PASS / 2 FAIL (146)** |
| Overall verify exit | **1 — not green** |

Every new contact case validates authenticated role, non-superuser/non-BYPASSRLS status, row_security=on and synthetic subject before protected queries. Privileged actions are only fixture construction/read-back, never counted as RLS proof. The suite does not weaken or skip legacy C3/G1 assertions. The 57 passing contact names and per-RPC success/denial/known-error outcomes are in the unedited full output; errors in unrelated functions are not counted as functional success.

Build and credential-boundary output: [TASK_5_2_BUILD_RAW.txt](evidence/TASK_5_2_BUILD_RAW.txt). HTTP readiness: [TASK_5_2_HTTP_HEALTH_RAW.json](evidence/TASK_5_2_HTTP_HEALTH_RAW.json): health and route manifest 200; unauthenticated contact notifications 401 with private/no-store caching. Browser walkthrough with real sign-ins is not claimed.

## 5. Bugs and unfinished work by severity

- **High — existing full-gate blockers:** C3 expiry read-back failure and G1 expired-invitation fixture CHECK failure remain open; neither is waived by this task.
- **High — additional legacy runtime defects discovered:** `accept_current_consent` and `refresh_my_availability_instances` return SQLSTATE `42702` with the valid synthetic fixture used in the response scan. They are not fixed in this contact-only task and are not described as working. The privacy scan proves no number in the observed responses/errors, not functional correctness of those older RPCs.
- **Medium — operational limitations:** real outbound email relay delivery and the 90-day purge job are not configured/implemented; they must be completed before a real-parent pilot. No mail, email notification or retention execution is claimed.
- **Low — contact UX limitation:** backup selection currently uses membership UUIDs supplied by chosen backups; no discovery directory/backup picker or partner-number display screen was added. The secure disclosure RPC/API exists and is live-tested.
- **Task 5.2 security:** independent read-only review identified no concrete exploit in the reviewed SQL/API/UI paths. This is bounded review evidence, not a claim that undiscovered defects cannot exist.

## 6. Guardrail risks

Numbers are necessarily returned to the authorised recipient at disclosure time; subsequent revocation cannot erase a number already remembered/copied to their device. The UI must not promise retroactive erasure. No new child fields, location, exact trust score, money field, transfer or payment/safety paywall is added. Audit payloads and notifications contain no phone number; server logs suppress driver/parser details. Ordinary clients cannot rewrite consent facts, backup snapshots, cancellation history or inbox rows. Sufficiently privileged administrators can alter database objects via DDL; this is not protection against a malicious schema owner.

TEST fixtures are transaction-scoped and rolled back. The post-run read-only query returned **zero** contact-fixture schools/users, consent rows, private-number rows, backup rows, cancellation rows and notification rows: [TASK_5_2_CLEANUP_RAW.json](evidence/TASK_5_2_CLEANUP_RAW.json). No test contact data remains. Source saving does not migrate DEV. DEV still lacks 0018/0019, so the new operations must not be represented as deployed there.

## 7. Exact verification steps

1. Use only the separate synthetic TEST project in protected `SUPABASE_RLS_TEST_DATABASE_URL`. Do not point these fixtures at DEV.
2. Run `npm run test:contact:live`: applies missing TEST migrations, checks function governance and runs every contact case with verbose names.
3. Run `npm run verify` for all stages. Until separately fixed, expect the retained legacy C3/G1 failures; do not disable them to report green.
4. With real signed-in TEST parent JWTs (not a service-role key), use `grant_contact_sharing` as an accepted participant, then `get_shared_contact` as its partner/selected backup with the owner's membership ID. Unrelated/School B users receive NULL, anonymous calls are denied.
5. Call `revoke_contact_sharing` as the consenting owner. Read back terminal state, revoked_at, cancellation event and the partner's own inbox under their own authenticated role; getter returns NULL to all former recipients. Repeating withdrawal must not create another event/notification.
6. UI click path, when a correctly migrated TEST-backed app with accepted fixtures is used: approved parent → Matches → accepted swap → Contact sharing → number/optional backup IDs → policy acknowledgement → Enable sharing. Then Withdraw consent and end swap immediately. Partner: Matches → Contact notifications; the card updates within the runtime polling interval. This click path is implemented, not claimed as a real-login browser acceptance run.
