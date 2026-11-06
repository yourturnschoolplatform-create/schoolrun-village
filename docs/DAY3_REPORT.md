# YourTurn — Day 3 report

## (a) What works in source

Day 3 adds bilateral household protection, recurring personal school-run patterns, a rolling four-week schedule horizon, school terms/holidays, Today and Calendar views, cancellation events, and ICS export. The schedule UI uses Australian English and remains explicit that matching is not yet available.

A parent can create a one-time household confirmation code and share it privately with another verified parent at the same school. The code is stored only as a digest, expires after seven days, and becomes a confirmed household link only when the second parent claims it. Future matching can call `is_same_household`; that helper now returns a relationship result only when the caller is one of the two participants or an administrator.

Weekly **I can help** and **I need help** patterns accept only pickup/drop-off, weekday, local start/end times, a suburb-level label, capacity, and start date. The database expands a pattern over 28 school-local dates, skips holiday dates, and, when term periods exist, skips dates outside term. Every protected schedule overview refresh uses `refresh_my_availability_instances()` to top active patterns back up to a rolling four-week horizon. Local date/time strings are retained without UTC conversion so DST clock changes do not shift a planned local time.

The Today and Calendar views allow a parent to edit a whole pattern, cancel one instance, or cancel the whole pattern. Every cancellation creates an immutable `schedule_cancellation_events` record for Day 6; this stage deliberately does not score trust. `first_listing_created` is the only new analytics event and is IDs-only. The ICS endpoint serialises only the selected school’s future instances with `status = confirmed`; until a later matching stage produces confirmations, it exports a valid empty calendar rather than unconfirmed listings.

## (b) Tables and RLS status

All 23 application tables have `ENABLE ROW LEVEL SECURITY` in the migration contract:

| Group | Tables | RLS status |
| --- | --- | --- |
| Day 1 core | `schools`, `school_configs`, `profiles`, `school_memberships`, `role_assignments`, `audit_logs`, `analytics_events`, `feature_flags`, `trust_policy_versions` | Enabled and statically checked |
| Day 2 verification | `consent_documents`, `consent_acceptances`, `child_profiles`, `safety_declaration_versions`, `safety_declarations`, `school_invite_codes`, `school_invite_attempts`, `school_invitations` | Enabled and statically checked |
| Day 3 households | `household_links`, `household_link_invitations` | Enabled. Links are participant/admin visible; opaque invitation records have no direct browser access. |
| Day 3 calendar/schedule | `school_calendar_periods`, `availability_patterns`, `availability_instances`, `schedule_cancellation_events` | Enabled. Calendar reads require current school membership; moderator/admin manage calendar. Personal schedule/cancellation reads are owner-plus-current-school or admin. Raw schedule writes are revoked; audited security-definer RPCs carry mutations. |

The Day 3 migration also revokes `PUBLIC` execution from internal date/expansion functions. Browser roles receive only the user-facing, authenticated RPCs. Normal Express schedule requests use the signed-in visitor JWT through the request-scoped Supabase client; no service-role client is used.

## (c) Verification output

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run test:unit` | Passed — 22 tests across 6 files |
| `npm run test:rls:contract` + migration validator | Passed — 35 static assertions; 23 tables with RLS contract |
| `npm run build` | Passed — Vite client and Express production bundle |
| `npm run test:e2e` | Passed — 3 existing PWA/onboarding regression tests |
| `npm run check:secrets` | Passed — no service-role or migration/test DB URL in browser, build, or normal runtime code |
| Runtime health / routes | Passed — `/api/health` 200 and `/manus-routes.json` 200; public config contains no service-role field |
| `npm run verify` (includes live RLS) | **Blocked** at `db:migrate:test` with safe PostgreSQL error `28P01`; no URL, password, key, or connection string was logged. |

The isolated test-project migration/live-RLS step is intentionally not treated as a pass. The harness is configured to use `SET LOCAL ROLE authenticated`, enables `row_security`, sets a synthetic user claim, and asserts that the query role is non-superuser. It now includes School B parent/moderator cross-school reads and Day 3 mutation attempts, third-party household-oracle denial, and direct internal expansion-RPC denial. It cannot execute until the test-project database credentials authenticate.

## (d) Known bugs by severity

### Blocker

- **Live migration/RLS evidence is blocked by PostgreSQL authentication error `28P01`.** The source and static tests are complete, but Day 1–3 migrations have not been proven against the isolated test project in this session. Likely cause: the test-project direct PostgreSQL connection uses an incorrect password, username format, or host/pooler configuration. Correct `SUPABASE_RLS_TEST_DATABASE_URL`, or run the ordered migrations in the SQL Editor and then use the JWT/API approach documented below.

### High

- None known in the source implementation after the Day 3 security review remediation.

### Medium

- Full browser interaction E2E for an approved parent creating/cancelling a real DB pattern is pending the same test-project authentication fix. Existing Playwright tests cover the public PWA/onboarding regression path only.

### Low / intentional limitation

- Confirmed-trip ICS may be empty until a later matching/acceptance stage creates confirmed instances. This is intentional: Day 3 must not export speculative help listings as confirmed trips.

## (e) Guardrail risks and controls

No payment, price, cash-credit, contact sharing, child data expansion, live location, map pin, coordinate, route, or address field was introduced. The UI and database both reject numeric address-like labels and common trailing road/street forms such as `Smith Street` and `Main Road`; the label is limited to a broad suburb/neighbourhood form. The main residual risk is operational rather than code-level: live RLS/migration evidence remains unavailable until the isolated test database credential issue is corrected.

## (f) Exact click path after migrations are applied

1. Sign in with a verified, approved parent who has completed the safety declaration.
2. From the verified home screen, open **Today**. The **Your school-run rhythm** schedule hub appears.
3. In **New weekly pattern**, choose **I can help** or **I need help**, **Pickup** or **Drop-off**, weekday, local time window, suburb-level area label, capacity, and start date; then select **Create four-week pattern**.
4. Select **Calendar**. The next 28 school-local dates are listed. The seeded **Sample school closure** appears as a holiday and says school-run patterns are skipped automatically.
5. On an open dated listing, select **Cancel this date** to cancel only that instance. From **Recurring patterns**, select **Cancel whole pattern** to cancel all future open instances. Both paths create Day 6 cancellation inputs.
6. Select **Export confirmed trips (.ics)**. The browser downloads `yourturn-confirmed-trips.ics`, containing only confirmed trips for the selected school (or a valid empty calendar before matching exists).
7. To link a household without profile search, choose **Create household confirmation code**, privately share the one-time code with the other verified parent, and have them enter it in **Enter a household confirmation code** then choose **Confirm household code**.

## Follow-up needed

Apply the migrations in order and fix the isolated test-project direct database credentials, then run `npm run verify` again. The ordered SQL Editor sequence and JWT/API fallback are documented in [SQL_EDITOR_AND_JWT_RLS_TESTS.md](SQL_EDITOR_AND_JWT_RLS_TESTS.md).

Wait for **`GO DAY 4`** before beginning the next product stage.
