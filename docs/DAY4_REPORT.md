# YourTurn — Day 4 report

## (a) What works in source

Day 4 adds same-school reciprocal matching and two-party swaps. Candidates require a viewer’s `I need help` instance, another verified parent’s compatible `I can help` instance, and the reverse pair. The school-configured time window is applied; strict same-date reciprocity is the default, with a four-week different-date option only when enabled by the school. Ranking returns coarse area label, time overlap, and a trust **band** only.

The Matches tab supports proposing, accepting, declining, withdrawing, expiring and blocking. A swap is `proposed` until the recipient accepts. Child nickname/year level is queried only for accepted-swap participants. There are no price, amount, contact, address, coordinate, route, map, or exact trust-score fields.

The database model has `match_blocks`, `swap_proposals`, and two reciprocal `swap_legs`. Security-definer commands apply advisory locks, verify same-school verified membership, exclude confirmed households and blocks, revalidate open/future legs on acceptance, and prevent cancellation of an instance reserved by a proposed or accepted swap. First-view and first-accept analytics are IDs-only.

## (b) Tables and RLS status

All **26** application tables have RLS enabled by the static contract. Day 4 adds:

| Table | RLS / write boundary |
| --- | --- |
| `match_blocks` | Owner-only read; writes only through authenticated block RPC |
| `swap_proposals` | Participant-only read; writes and state changes only through authenticated proposal/transition RPCs |
| `swap_legs` | Visible only to the linked swap’s participants; created only by proposal RPC |

The proposal and reveal RPCs use the signed-in JWT request context, not service role. Accepted-only child reveal is enforced in `get_accepted_swap_children`.

## (c) Verification output

- Typecheck: passed.
- ESLint: passed.
- Unit tests: **27 passed** across 8 files.
- Static RLS/migration contract: **39 passed**; 26 RLS-enabled tables.
- Build: passed (Vite plus Express bundle).
- Playwright regression: **3 passed**.
- Secret boundary: passed; no service role or DB URL in client/build/normal runtime source.
- Runtime: health and route manifest both returned HTTP 200; public config has no service-role field.
- `npm run verify`: typecheck/lint/unit tests passed, then isolated test DB migration stopped at safe PostgreSQL error **`28P01`**. No connection string or key was logged.

## (d) Known bugs by severity

### Blocker

Live migration and non-privileged RLS/concurrency evidence cannot execute until `SUPABASE_RLS_TEST_DATABASE_URL` authenticates. The test DB failure is `28P01`, likely password, username-format, or pooler-host configuration. The report does not treat the static contract as a live RLS pass.

### High

No known source-level high severity issue remains after the independent review remediation. Actual SQL execution is still pending the test DB credential repair.

### Medium

The browser acceptance flow with two real approved test parents cannot run until migrations are applied to the isolated test project. Existing Playwright coverage remains public/onboarding regression coverage.

## (e) Guardrail risks

Day 4 adds no money, price, amount, credit, phone, email, address, map, location, route, or exact trust-score field. Candidate and pending responses contain only a display name, band, coarse area label, overlap and dates. The remaining risk is operational: live DB proof is blocked by the isolated project connection.

## (f) Exact click path after migrations

1. Sign in as a verified, approved parent with reciprocal open `I need help` and `I can help` dated instances.
2. Open **Today** → **Matches**.
3. Review a candidate’s display name, trust band, coarse area and reciprocal dates; optionally tick **Include reciprocal dates within four weeks**.
4. Select **Propose swap**. The other parent sees an incoming proposal in **Your swap proposals**.
5. The recipient selects **Accept**. Only then is the swap accepted.
6. Either accepted participant selects **Show child nickname and year level**; this reveal is unavailable while proposed.
7. Select **Block** on a candidate to remove that pair from future matching.

Apply migrations in order through `0010_day4_swap_integrity_remediation.sql`, repair the isolated test DB credential, then rerun `npm run verify`. Wait for **GO DAY 5**.
