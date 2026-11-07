# YourTurn guardrails

## Absolute product limits

YourTurn never accepts or transfers payments, money, tips, fees, prices, cash-value credits, or anything redeemable for cash. It does not arrange in-home care. Every trip is a school pickup or drop-off trip.

Safety features are never paywalled. The product does not collect or display live location data. Do not introduce a map-tracking field, location polling, coordinates, route history, or passive background location permission.

## School and child privacy

A user may access only their own verified school’s information. School identity is not a UI filtering convenience: it is an RLS boundary enforced in the database. No client-side state, API query, or analytics event may become a cross-school discovery route.

Child data is limited to nickname and year level. Do not create fields for surnames, dates of birth, photos, school IDs, health details, home addresses, or other child personal information. Phone numbers are not public school-notice data; contact disclosure is a later, versioned, revocable feature. Community discussion bodies must not accept child full names, photos, phones or emails; they never store nicknames or trust scores either.

Day 3 schedules store only a coarse suburb-level area label, local time windows, weekdays, direction, capacity, school date, and cancellation state. They must not store addresses, street names, coordinates, map pins, route geometry, GPS traces, or household residential details. A household link is a bilateral relationship state, not an address record; matching must later exclude confirmed household pairs.

Day 4 candidate and pending-swap responses may contain only a school-scoped display name, coarse area label, time-window overlap, reciprocal date, and trust band. They must never contain exact trust score, child nickname/year level, phone, email, home address, coordinates, map data, contact disclosure, payment/amount, or a route. Child nickname/year level can be returned only through an accepted-swap participant check; block records must be mutual-match exclusions and not a discovery channel.

## Security rules

All application data tables require RLS. The ordinary server client must carry the actual signed-in user JWT. Do not replace it with a service-role client for convenience. The service-role key is server-only and may be imported only from `server/admin/service-role.ts` by the administrative bootstrap, scheduled-job, and notification modules. It must never enter `src/`, generated static assets, Vite environment variables, browser configuration, logs, documentation, test snapshots, or error messages.

Key actions need audit records. `audit_logs` is append-only: application roles do not update or delete audit rows. Security holds, verification, role changes, policy publication, penalties, appeals, and administrative bootstrap are key audited actions when their workflows are implemented.

## Copy and scope rules

All customer-facing copy uses Australian English: for example, *organisation* where relevant, *mobile number*, *school pickup*, and *programme* only when the school itself uses that term. Do not claim that a foundation-only screen can match parents, create swaps, share contact details, notify backups, approve moderation cases, or process an appeal.

When a feature is not yet operational, present it as “foundation in progress” rather than as an enabled control. Any proposal that needs a guardrail exception must be rejected or explicitly approved in a future decision update.


## Function and table admission rule

Every new `public` function must use explicit grants only, have a fixed `search_path`, be listed in the function allowlist before browser-facing execution is permitted, and receive a non-privileged cross-school live test. `anon` must not receive public-function execution or public-table privileges. Every new table must enable RLS and have a live RLS test before it can be marked `[x]`. Security-definer helpers used by RLS policies may receive the minimum `authenticated` execute permission required for policy evaluation, but are never anonymous and must not be exposed as browser RPCs.

## Task 5.1 ledger invariants

`swap_ledger_entries` is immutable history: application roles have SELECT only, and raising row/statement triggers prohibit UPDATE, DELETE and TRUNCATE. Each completed accepted leg yields exactly one directed +1 obligation between its recipient and provider memberships in the same school. Do not add a correction, transfer, third-party recipient, monetary field or browser completion command. A later handover must set the trusted completion marker only after both confirmations; Task 5.1 does not provide that workflow.

Expiry must not mutate or delete a row or issue a score penalty. Compute `is_expired` from `expires_at` during reads; only unexpired entries affect per-partner net counts. Reminder timestamps do not imply a running notification job. New Task 5.1 functions have `search_path = pg_catalog` only, schema-qualified application calls, explicit revokes/grants, and allowlist records. Trigger-only functions are declared under `internal` and remain inaccessible to anon/authenticated callers. Every new table and callable function needs live cross-school coverage before `[x]`.

Ledger fixtures use unique synthetic IDs inside a per-test transaction with unconditional rollback. They must never be run against DEV. Privileged fixture completion and read-back are labelled infrastructure actions, not RLS proof; all participant-isolation and write-denial assertions execute as a verified non-superuser, non-BYPASSRLS `authenticated` role with synthetic claims.

## Task 5.2 contact boundary

A mobile string may be stored only in `yourturn_private.mobile_numbers`. Never expose that schema/table to browser roles, even its owner. The sole intentional disclosure surface is `get_shared_contact` (and its no-store JWT HTTP wrapper), guarded by active accepted swap, current owner consent, same-school verification and partner/version-specific backup identity. No view, profile, list/match RPC, notice, inbox, audit/analytics payload or grant response may copy the number. Errors and request-parser failures must not log submitted values or driver details. Browser forms clear numbers after use and never persist them in storage or URLs.

Consent facts/versions and backup selections are immutable; only one-way current-version supersession/revocation is allowed through scoped RPCs. Withdrawal must remain possible for an existing consenting owner after suspension or policy expiry. Atomically cancel the swap, revoke access for both sides and backups, append a cancellation event and notify only its partner with fixed number-free copy. Never claim external email delivery without transport configuration. Retrieval rights can be withdrawn, but an already disclosed number cannot be erased from another person's memory/device; users must not be told otherwise.

## Task 5.3 handover boundaries

The only browser confirmation entry points are confirm_pickup_done and confirm_child_arrived, with a leg UUID only. Server-derived membership must match provider and recipient respectively, with an active same-school membership and accepted source swap. No client timestamps, actor/school identifiers, child notes or location data are accepted. Confirmations and reminder history are immutable and cannot be directly written by browser roles. Completion, unique ledger posting and IDs-only first-trip analytics are one transaction. Each participant's completion-analytics identity is projected only from that participant's immutable auth.uid()-derived confirmation.

The expected-arrival default is the end of the recipient's requested time window in the school's timezone, not a live ETA. Freeze source role/instance identity and expected arrival after confirmation begins. Reminder records require exactly one confirmation, an accepted incomplete leg and expected arrival + 30 elapsed minutes. Later completion/cancellation makes old reminder records ineligible for delivery without deleting history. Delivery must recheck current eligibility before enqueueing `handover_reminder` onto the email-relay path; authenticated callers must never claim or send that kind.

Native TEST cron runs only the fixed statement select public.enqueue_due_handover_reminders(). No private payload, email, mobile or child data is put in cron commands/log parameters. Keep vendor cron ownership/RLS intact; deny browser schema access and prove actual anonymous/authenticated reads denied. Vendor job/log RLS is recorded separately from the two new app tables. All new app functions have explicit grants, pg_catalog-only paths, allowlist records and cross-school live assertions. Apply SQL/schedules/fixtures to TEST only; source checkpoint changes never imply DEV migration or outbound notification delivery.
