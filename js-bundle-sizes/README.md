# JS bundle sizes custom check

A standalone example of a Meticulous **custom check**, built against the
published [`@alwaysmeticulous/custom-checks`](https://www.npmjs.com/package/@alwaysmeticulous/custom-checks)
npm package.

## What it does

This check looks for **JavaScript bundle-size regressions**. It sums the
JavaScript (script) bytes each session loaded during a replay and flags the
sessions whose total grew materially on your change (head) versus the baseline
(base).

### Background: the `js-bundle-sizes` snapshot

During replay, Meticulous records a built-in `js-bundle-sizes` snapshot: one
entry per JavaScript (script) load, holding the served URL and its size in bytes
(from the response's `content-length`, or the served body when that header is
absent). It needs **no application code** — Meticulous records it itself — and is
enabled separately; ask the Meticulous team to turn it on for your project.

Each bundle is counted **once per URL** (the largest reported size wins), so a
chunk loaded twice — e.g. a `<link rel="modulepreload">` plus the executed
`<script>` — is not double-counted. A session's total is the sum of those
deduped per-URL sizes.

### How a verdict is reached

Given a test run (identified by its id or by `--commitSha`), the script:

1. Waits for the test run to finish.
2. Fetches the per-session `js-bundle-sizes` snapshots for the run and for its
   base, via `getSnapshotsFromTestRun`.
3. Totals the deduped bundle bytes per session on head and base, aligned by
   `sessionId`. Sessions that ran only on head (no base replay) are omitted —
   they cannot regress against a non-existent baseline.
4. Computes a verdict:
   - **warn-without-requiring-user-ack** if any session's total grew by at least
     10% (`WARN_PERCENT_INCREASE_THRESHOLD`), or a session with no base JS
     loaded enough new JS to clear the byte floor.
   - **warn-and-require-user-ack** if any session's total grew by at least 20%
     (`FAIL_PERCENT_INCREASE_THRESHOLD`).
   - **pass** otherwise.
5. Reports the verdict plus a markdown report back to Meticulous (so it shows up
   alongside the test run), unless `--dryRun` is passed. The report is a single
   **summary table** with one row per session whose total JS bundle size grew
   (most degraded first), showing its base → head totals, delta and percentage,
   linked back to the session in the app.

### What gets excluded (to keep the verdict quiet)

- **Session pairs where neither side loaded at least `MIN_BYTES_FOR_ALARM`
  (50 KB) of JavaScript** are dropped: below that floor a large relative swing
  is only a few KB (a single small chunk shifting) and the percentages are
  misleading (4 KB → 8 KB = +100%).
- **Bundles whose served size could not be determined** are left out of the
  totals and surfaced only as a footnote.

With `--dryRun`, the script computes and prints the verdict and the markdown
report to stdout **without** reporting anything back — useful for local
iteration.

## Prerequisites

- **Node.js 18+**
- A `METICULOUS_API_TOKEN`.
- **The `js-bundle-sizes` snapshot enabled for your project** — ask the
  Meticulous team to turn it on.

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
`report-js-bundle-sizes.ts` and set `PROJECT_URL` to your project's base URL,
replacing the `<organization>` and `<project>` placeholders with the slugs from
your project's URL in the Meticulous app:

```ts
const PROJECT_URL = "https://app.meticulous.ai/projects/acme/web";
```

The script refuses to run while the placeholders are still present.

### Options

| Option              | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `<testRunId>`       | Positional. The test run to report against.              |
| `--commitSha <sha>` | Resolve the test run from a commit SHA instead of an id. |
| `--apiToken <tok>`  | API token (defaults to `$METICULOUS_API_TOKEN`).         |
| `--dryRun`          | Compute and print the result without reporting it back.  |

## Customize

Before using this in your own project, review and adjust:

- `PROJECT_URL` — **required.** Your Meticulous project's base URL (see above).
- `WARN_PERCENT_INCREASE_THRESHOLD` / `FAIL_PERCENT_INCREASE_THRESHOLD` — how
  much a session's total must grow to warn vs. require acknowledgement.
- `MIN_BYTES_FOR_ALARM` — minimum JS a session must load before it can alarm.
- `MAX_PASSED_SESSIONS_IN_TABLE` — how many non-threshold sessions the summary
  table shows before truncating.
- `CHECK_ID` — stable identifier shown in the Meticulous UI.

## Type checking

```bash
npm run typecheck
```
