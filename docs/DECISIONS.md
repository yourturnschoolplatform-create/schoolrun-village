# YourTurn final decisions

## School, verification, and roles

The pilot is two Victorian schools, each with an independent timezone and school configuration. Verification requires verified email, valid school invite code, moderator approval, and a timestamped self-declaration for licence, insurance, child restraints, and school pickup rules. Documents are not uploaded. The UI shows one school per user. The schema supports more memberships, and a school switcher remains behind a disabled flag.

Volunteer moderators are restricted to their own school and must accept a code of conduct. Their response target is 24 business hours. The escalation administrator is the product owner. Administrators may be global; administrator bootstrap is keyed by `YOURTURN_ADMIN_EMAIL` and must be audit logged.

## Swap and safety policy retained as versioned product policy

Swaps are pickup/drop-off trips only. Matching is within ±15 minutes, configured by school. Strict reciprocity is the default, with optional reciprocal trips on different dates within four weeks. Trips owed are numeric counts only: pair-specific, non-transferable, eight-week expiry, a week-six reminder, and silent expiry.

Trust begins at 70. Completed trip: +1. Eligible urgent cover: +3 (posted within four hours of pickup; maximum two per user per week; no same-household use). Cancellation under 24 hours: -3; under two hours: -8. A 15+ minute late arrival after the window start is -2 if a running-late notice was sent before the window start, otherwise -5. Confirmed no-show is -20, or -10 where a backup accepts; it also adds two trips owed. Confirmed false report is -15. A reviewed safety violation is -25.

Trust bands are: Trusted 85+; Standard 60–84; Caution 40–59; Restricted 20–39; Suspended below 20 or administrator-suspended. Other parents see a band, not the score. Thresholds and actions are editable only through an immutable, versioned policy record.

No-show reports are provisional until undisputed for 24 hours or confirmed by a moderator. Appeals are accepted within 48 hours. A moderator may apply an immediate safety hold that disables swaps only, alerts an administrator, is reviewed within 24 hours, and can be appealed.

Day 4 candidates require a reciprocal pair of pickup/drop-off instances from two verified parents in the same school. The school window is ±15 minutes unless its configuration says otherwise. Same-date reciprocity is the default; users may opt in to a different reciprocal date only within the school-configured 28-day window and only when the school allows it. A proposal expires after 48 hours, is accepted only after the recipient confirms, and is capacity-reserved transactionally across both reciprocal legs. Trust is ranked and displayed by band only; numeric scores never leave the database. Child nickname and year level become visible only to the two accepted-swap participants, never in candidate or pending-proposal data. A block in either direction removes the pair from matching.

Departure confirmation is requested by push, email, and in-app banner 30 minutes before pickup with a 15-minute timeout. Both opted-in backups (maximum two) are notified at once; the first acceptance covers. A child-not-collected urgent action exists in a later feature stage.

## Contact, privacy, retention, and marketplace decisions

Email relay is the default. After a swap is accepted, each parent may opt in to share a mobile number with the partner and chosen backups only. Disclosure is versioned and revocable; revoking it ends that swap. School notices show display name only, never a mobile number. Departure checks, contact disclosures, and notice logs are deleted 90 days after a swap ends.

The item board supports free giveaway/lending only: there is no price field. Restricted items are admin-editable. There is no live location tracking.

School-scoped discussion community content is text-only for verified same-school members. Threads, posts, comments and likes never store photos, phones, emails, addresses, child nicknames, trust scores, or amount/price/currency. A privacy filter rejects phone numbers, email addresses, photo phrasing and child full-name phrasing before insert. Authors appear by parent display name only.

Community moderation: verified same-school members may file one report per target with a privacy-filtered reason; authors cannot report their own content. After three unique reports the target auto-hides. Own-school volunteer moderators may hide, restore (hidden → active), or remove (withdraw) content and read a hidden-content queue. Reports and moderation actions are append-only. School B cannot moderate or report School A content.

## Technical decisions

Use Vite + React + TypeScript + Tailwind with Express + TypeScript. Supabase Postgres is the only application data store, in Sydney, with Supabase Auth email identity. Apply all migrations from `/db/migrations`. Turn RLS on for every table. Express uses a per-request client bearing the signed-in user JWT. The service-role key appears only in server-only administrative code for bootstrap, scheduled jobs, and notification sending. It is never present in client source, client configuration, static output, or browser payload.

The PWA caches only app-shell and same-origin static assets. Authenticated pages may use the cached shell as an offline fallback, but it must contain no profile, session, or API data. API and Supabase responses are never cached by the service worker.

## Task 5.1 — immutable trip-count ledger

The new ledger is a directed obligation from the recipient's membership to the provider's membership, derived from an accepted swap leg's trusted `completed_at`. Each leg emits exactly one +1 row; clients cannot mark completion or write ledger rows. A completion integration hook is not a handover workflow: there is no public one-party completion RPC in Task 5.1. A later two-confirmation handover must set the trusted marker transactionally.

The raw ledger never changes. Eight weeks and six weeks mean exactly 56 and 42 elapsed UTC days from completion, independent of daylight saving. `get_my_ledger()` has no identity/school arguments and derives the caller through `auth.uid()`, then the first fully onboarded verified school membership. Its `entries` retain expired history with a computed `is_expired` marker; `partners` excludes expired entries and offsets opposite directions within the exact membership pair only. `trips_i_owe` and `trips_owed_to_me` are nonnegative counts. A mutable expired flag would contradict append-only semantics and is intentionally not stored. The timestamp fields provide future reminder scheduling data, not a delivery job in this task.

New SQL is applied to the separate synthetic TEST project only for this task. A normal source checkpoint may advance main without rewriting G6 history; it is not a DEV database migration or publication. DEV retains migrations through 0017 until separately authorised.

## Task 5.2 — private contact consent

A parent opts in only after acceptance. The statement shown in Australian English is: “Email relay is the default. Your mobile number is shared only with this swap partner and up to two chosen backups. Once you enable sharing, keeping consent is a condition of this swap. Withdrawing consent ends it immediately.” The versioned policy is `policy_version = 1`; each new grant creates a monotonically increasing `consent_version` for that swap/member. Superseding a scope/number snapshot retires its old version without cancelling the swap; explicit withdrawal does cancel it. Scope is fixed to `swap_partner_and_chosen_backups`, limited by school max_backups and never more than two. This selection does not enrol departure cover or expose a backup's own number.

Numbers are Australian E.164 mobile strings in `yourturn_private.mobile_numbers`, keyed by consent version. There are no client schema/table privileges or RLS policies there. Only `get_shared_contact` may disclose the number; the owner's partner or selected backup must currently be verified and fully onboarded in the same school, and the swap/consent/owner must still be active. Anonymous callers cannot execute any contact function. Consent metadata is owner-readable only; no phone is copied to profiles, notices, logs, analytics, cancellation events or inbox messages.

Grant and withdrawal lock the proposal to serialise versions/cancellation. Withdrawal records revoked_at and `cancelled_consent_revoked` while retaining accepted_at, appends one cancellation event and a fixed phone-free partner notification atomically. Repeated withdrawal is idempotent. Losing verification/safety onboarding does not remove an existing owner's right to withdraw; it does remove grant/read rights. A cancelled swap cannot be revived by granting again. Ledger history is untouched.

Partner notification is a real in-app inbox row, displayed/polled while Matches is open. Email relay is the declared default channel policy; no outbound email transport is configured, so this task does not claim to send relay email or email notifications. The UI explicitly states this limitation. Task 7.3 adds operational 90-day purge of contact disclosures, notice logs, departure checks, and email-relay rows after swap end on TEST; ledger, trust history, children, and confirmations are never purged. SQL is applied to TEST only; DEV and publication remain unchanged.

## Task 5.3 — two-party handover

Only the accepted leg provider may record pickup_done and only its recipient may record child_arrived, in either order. Each immutable confirmation derives its actor membership through auth.uid(); clients cannot supply actors, schools or timestamps. Both facts are required for application completion. The source leg and proposal are transaction-locked in proposal-first order, shared with consent withdrawal, to serialise completion/cancellation. Task 5.1's completion hook posts the exactly-once ledger entry. Timestamp validation in that hook uses the actual database clock so a confirmation recorded after a lock wait is not mistaken for a future event relative to statement start.

Initial expected arrival is the end of the recipient's requested service window converted using its school timezone; this is a v1 scheduling assumption, not a travel-time calculation. It is immutable once any confirmation/completion exists. A missing-second-confirmation record becomes eligible at expected arrival + 30 elapsed minutes, in either order. Zero/both confirmations and nonaccepted swaps are not eligible. Store one immutable record per leg/missing kind; later completion/cancellation resolves eligibility without deleting history. Delivery (Task 8.3) rechecks live eligibility before enqueueing a `handover_reminder` email-relay row; completed or cancelled legs are suppressed without deleting reminder history. Authenticated callers cannot enqueue, claim, or send handover reminders. A participant-scoped refresh and private service sweep create reminder records; native TEST scheduling remains separately evidenced.

Completion emits first_trip_completed once for each participant. Each stored actor is projected from their immutable confirmation, whose membership was derived from auth.uid() on their own earlier call, not from an arbitrary actor argument. School comes from the accepted leg. Historical privileged ledger-fixture completion remains labelled infrastructure, not an application confirmation path. Apply new SQL and fixtures to TEST only, not DEV.

### Task 5.3 review remediation

Independent read-only review identified a possible cross-proposal unique-analytics-key deadlock if two swaps involving the same users insert their two first-trip events in opposite orders. Migration 0021 orders the server-derived actor IDs before ON CONFLICT. This is deterministic lock-order hardening, not a claimed reproduced concurrent race. Existing per-proposal and per-leg locks still serialize confirmation/cancellation, and idempotency/analytics are live-tested. A two-connection committed-fixture race is not claimed by this increment's rollback-only tests.
