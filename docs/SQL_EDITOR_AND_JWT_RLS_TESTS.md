# SQL Editor migration order and JWT-based RLS tests

## Run migrations in the Supabase SQL Editor

The direct database connection currently fails authentication, so run the following files **one at a time** in the SQL Editor of the intended Supabase project. Do not combine them into a single editor submission. Each file has its own transaction and finishes with `commit;`.

1. [`0001_day1_foundation.sql`](../db/migrations/0001_day1_foundation.sql)
2. [`0002_day2_enum_values.sql`](../db/migrations/0002_day2_enum_values.sql)
3. [`0003_day2_onboarding_and_hardening.sql`](../db/migrations/0003_day2_onboarding_and_hardening.sql)
4. [`0004_day2_sample_pilot_data.sql`](../db/migrations/0004_day2_sample_pilot_data.sql)
5. [`0005_day2_security_remediation.sql`](../db/migrations/0005_day2_security_remediation.sql)
6. [`0006_day3_households_schedules_calendar.sql`](../db/migrations/0006_day3_households_schedules_calendar.sql)
7. [`0007_day3_sample_calendar.sql`](../db/migrations/0007_day3_sample_calendar.sql)
8. [`0008_day4_reciprocal_matching_swaps.sql`](../db/migrations/0008_day4_reciprocal_matching_swaps.sql)
9. [`0009_day4_matching_remediation.sql`](../db/migrations/0009_day4_matching_remediation.sql)
10. [`0010_day4_swap_integrity_remediation.sql`](../db/migrations/0010_day4_swap_integrity_remediation.sql)

Run this ordered set in the **development project** first. Then run the same ordered set in the separate **test-only project** before running live RLS tests. `0002` must finish before `0003`, because the latter relies on the enum values committed by the former.

The supplied [`two-school.sql`](../db/fixtures/two-school.sql) fixture is designed for privileged, direct-Postgres test setup and uses synthetic `auth.users` rows. Do not use it as the JWT test-user fixture: its users are not intended to log in with passwords.

## Replace direct database RLS assertions with Supabase API assertions

Use three strictly separated test phases in the **test-only Supabase project**:

1. **Privileged bootstrap only.** A temporary server-side test bootstrap uses the test project's secret key to create or reset synthetic test users with `auth.admin.createUser({ email, password, email_confirm: true })`. It also seeds only synthetic schools, memberships, roles, consent acceptances, declarations, and invite records using the Data API. The secret key stays in a server-only test process and never reaches Playwright, browser code, logs, or test output.
2. **Real sign-in.** For each synthetic person, call `auth.signInWithPassword({ email, password })` with the test project's publishable key. Retain only the returned access token in process memory for the duration of the test.
3. **RLS assertions.** Call the test project's Data API with the publishable key as `apikey` and that person’s access token as `Authorization: Bearer <token>`. Do not use a secret/service-role key in any assertion request. A publishable key plus a signed-in user JWT maps to the Postgres `authenticated` role; a secret/service-role key bypasses RLS and is therefore unsuitable as evidence.

This replaces `SET ROLE` for the externally observable RLS suite. It exercises the actual Supabase Auth, API gateway, PostgREST, table grants, RLS policies, and `auth.uid()` path that browser and Express requests use.

## Recommended isolated test configuration

Keep these values only in protected CI/test secrets, never in source:

- `RLS_TEST_SUPABASE_URL` — test project Project URL.
- `RLS_TEST_SUPABASE_PUBLISHABLE_KEY` — test project publishable/anon key; safe to use in browser tests.
- `RLS_TEST_SUPABASE_SECRET_KEY` — test project secret/service-role key; bootstrap process only.
- Per-principal synthetic passwords such as `RLS_TEST_PARENT_SOUTH_PASSWORD` and `RLS_TEST_MODERATOR_SOUTH_PASSWORD`; use random values and do not log them.

The test project must contain fake data only. Use distinct, clearly synthetic identifiers such as `yourturn_test_*`; never aim the bootstrap at the pilot or development project.

## Assertions to keep

For each request, require the signed-in user’s token. A School B parent must receive an empty result for School A’s `schools`, `school_configs`, `child_profiles`, and School A-only `safety_declaration_versions`. A School B moderator must see at least one School B pending membership but no School A membership. Both must be denied direct reads of `school_invite_codes` and denied raw membership updates. A parent with only an older global declaration must be denied access after a newer school-specific declaration is published.

For the Express API, launch the test server with the **test project** URL and publishable key, then send each real access token in `Authorization`. Assert that the moderator pending-membership response contains only that moderator’s school and that pre-approval status and invitation-opening responses contain no school name, identifier, configuration, roster, or inviter fields. Do not run the production/dev server against test data.

For Playwright, point a dedicated test server at the test project, sign in through the product UI with the synthetic credentials, and assert that School A’s display name never appears in School B user/moderator DOM, API payloads, or network responses. Keep this separate from the general Day 2 onboarding test so the database test data cannot leak into development.

## Minimal API shape

The signed-user request can be made with `fetch`; this sketch deliberately omits every actual secret and token:

```ts
const response = await fetch(`${testUrl}/rest/v1/school_configs?school_id=eq.${schoolAId}&select=school_id`, {
  headers: {
    apikey: testPublishableKey,
    Authorization: `Bearer ${schoolBAccessToken}`,
  },
});
const rows = await response.json();
expect(rows).toEqual([]);
```

Use the same token for the Express request:

```ts
const response = await fetch(`${testServerUrl}/api/onboarding/moderation/pending-memberships`, {
  headers: { Authorization: `Bearer ${schoolBModeratorAccessToken}` },
});
```

The bootstrap process is not evidence of RLS. It may use the secret key only to create confirmed synthetic Auth users and seed the isolated test project. Every allow/deny assertion must use a real signed-in user access token.

## Sources

Supabase documents that RLS policies and grants apply to authenticated user requests, while service-role/secret access bypasses RLS: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) and [API keys](https://supabase.com/docs/guides/getting-started/api-keys). The admin API can create a confirmed synthetic user with `email_confirm: true`, but it must run on a trusted server: [createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser). A user access token is obtained by signing the user in with email and password: [signInWithPassword](https://supabase.com/docs/reference/javascript/auth-signinwithpassword). The Data API requires an `apikey` header and exposes only explicitly granted objects: [Creating API Routes](https://supabase.com/docs/guides/api/creating-routes).
