# Network request capacity custom check

A standalone example of a Meticulous **custom check**, built against the
published [`@alwaysmeticulous/custom-checks`](https://www.npmjs.com/package/@alwaysmeticulous/custom-checks)
npm package.

## What it does

Given a test run (identified by its id or by `--commitSha`), the script:

1. Waits for the test run to finish.
2. Fetches the per-session `network-requests` snapshots for the run and for its
   base, via `getSnapshotsFromTestRun`.
3. Filters out common third-party noise (analytics, error tracking, and so on —
   see `IGNORED_REQUEST_HOST_SUBSTRINGS` in the script).
4. Counts meaningful network requests per session on head versus base (aligned
   by `sessionId`), and computes a verdict:
   - **warn-without-requiring-user-ack** if any session exceeds base capacity by
     at least 10% (`WARN_PERCENT_INCREASE_THRESHOLD`).
   - **warn-and-require-user-ack** if any session exceeds base capacity by at
     least 20% (`FAIL_PERCENT_INCREASE_THRESHOLD`).
   - **pass** otherwise.
5. Reports the verdict plus a markdown report back to Meticulous (so it shows up
   alongside the test run), unless `--dryRun` is passed. The report breaks each
   alarming session down per endpoint, grouping GraphQL calls by operation name
   (e.g. `GetUser (GraphQL)`) and collapsing id-like path segments to `:id` so
   dynamic routes group together.

Low-traffic sessions (fewer than `MIN_REQUESTS_FOR_ALARM` requests on both
base and head) are ignored so a single extra request does not trigger a false
alarm.

With `--dryRun`, it computes and prints the verdict and the markdown report to
stdout **without** reporting anything back — useful for local iteration.

## Prerequisites

- **Node.js 18+**
- A **project- or user-scoped** `METICULOUS_API_TOKEN`.
- **Custom snapshots turned on for your project** — ask a Meticulous admin to
  enable them.

## Install

```bash
pnpm install
# or
npm install
```

## Run

Dry run (compute + print, but do **not** report back):

```bash
METICULOUS_API_TOKEN=<token> npm run report -- <testRunId> --dryRun
```

Real run (reports the result back) — drop `--dryRun`:

```bash
METICULOUS_API_TOKEN=<token> npm run report -- <testRunId>
```

Resolve the test run from a commit SHA instead of passing a test run id:

```bash
METICULOUS_API_TOKEN=<token> npm run report -- --commitSha <sha>
```

Pass the API token as a flag instead of via the environment variable:

```bash
npm run report -- <testRunId> --apiToken <token> --dryRun
```

### Required: set your project URL

The report links each session back to the Meticulous app. Before running, open
`report-network-requests.ts` and set `PROJECT_URL` to your project's base URL,
replacing the `<organization>` and `<project>` placeholders with the slugs from
your project's URL in the Meticulous app:

```ts
const PROJECT_URL = "https://app.meticulous.ai/projects/acme/web";
```

The script refuses to run while the placeholders are still present.

### Options

| Option              | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `<testRunId>`       | Positional. The test run to report against.                  |
| `--commitSha <sha>` | Resolve the test run from a commit SHA instead of an id.     |
| `--apiToken <tok>`  | API token (defaults to `$METICULOUS_API_TOKEN`).             |
| `--dryRun`          | Compute and print the result without reporting it back.      |

## Customize

Before using this in your own project, review and adjust:

- `PROJECT_URL` — **required.** Your Meticulous project's base URL (see above).
- `IGNORED_REQUEST_HOST_SUBSTRINGS` — third-party hosts to exclude from the
  comparison.
- `WARN_PERCENT_INCREASE_THRESHOLD` and `FAIL_PERCENT_INCREASE_THRESHOLD`
  — how much extra traffic triggers a warning vs. requiring acknowledgement.
- `MIN_REQUESTS_FOR_ALARM` — minimum request count before a session can alarm.
- `CHECK_ID` — stable identifier shown in the Meticulous UI.

## Type checking

```bash
npm run typecheck
```
