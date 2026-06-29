# React component renders custom check

A standalone example of a Meticulous **custom check**, built against the
published [`@alwaysmeticulous/custom-checks`](https://www.npmjs.com/package/@alwaysmeticulous/custom-checks)
npm package.

## What it does

This check looks for **rendering performance regressions at the level of an
individual React component**. It counts how many times each component rendered
during a replay and flags the components that render materially more often on
your change (head) than on the baseline (base) — pinpointing *which* component
regressed.

### Background: the `react-component-renders` snapshot

During replay, Meticulous records a built-in `react-component-renders` snapshot.
On each React commit it walks the committed fiber tree and attributes the work to
the components that actually re-rendered (React's "performed work" flag),
recording a **per-component cumulative render count** at each comparison
screenshot. It needs **no application code** — Meticulous installs the hook
itself — and is a no-op on non-React pages. It is a heavier companion to the
whole-app `react-renders` snapshot and is enabled separately.

Each component is identified by its **resolved source location** (e.g.
`src/search/ResultRow.tsx:11:0`), recovered from your source maps. The check
aligns components across base and head by that source location rather than their
display name, because production builds often minify names differently between
builds while the source location stays stable. Counts are **per instance**: a
component rendered in many places (a list row, an icon) accumulates a render on
every instance, every commit, so its count can exceed the app's total render
count — what matters is the **delta vs base**.

A component whose render count jumps on head is the fingerprint of a localized
regression: usually a missing or broken memoization (`React.memo`, `useMemo`,
`useCallback`), an unstable prop or context value feeding that component, or a
new effect-driven render loop inside it.

### How a verdict is reached

Given a test run (identified by its id or by `--commitSha`), the script:

1. Waits for the test run to finish.
2. Fetches the per-session `react-component-renders` snapshots for the run and
   for its base, via `getSnapshotsFromTestRun`.
3. For each session, totals every component's renders on head and on base and
   aligns them by source location (falling back to display name).
4. For every component whose **base** count is at least `MIN_RENDERS_FOR_ALARM`,
   records its head-vs-base growth. (Components that exist only on head are not
   flagged — a brand-new component is not a regression of an existing one.)
5. Computes a verdict, using **both** a relative and an absolute threshold (a
   dual gate — both must be met), so neither tiny counts nor already-busy
   components produce noisy alarms:
   - **warn-without-requiring-user-ack** if any component rendered at least 50%
     **and** 25 more times than base
     (`WARN_PERCENT_INCREASE_THRESHOLD` / `WARN_MIN_DELTA_RENDERS`).
   - **warn-and-require-user-ack** if any component rendered at least 100%
     **and** 50 more times than base
     (`FAIL_PERCENT_INCREASE_THRESHOLD` / `FAIL_MIN_DELTA_RENDERS`).
   - **pass** otherwise.
6. Reports the verdict plus a markdown report back to Meticulous (so it shows up
   alongside the test run), unless `--dryRun` is passed. The report has two
   parts: a **summary table** with one row per degraded component (most degraded
   first), and a **per-component breakdown** listing the sessions each component
   degraded in — with base → head counts — linked back to the session in the app.

### What gets excluded (to keep the verdict quiet)

- **Components that rendered fewer than `MIN_RENDERS_FOR_ALARM` (25) times on
  base** are dropped: at low counts a couple of extra renders is a large,
  misleading percentage, and the count is dominated by one-off mount work.
- **Sessions whose components were recorded on only one of the two runs** (no
  base, or no head) are treated as _incomparable_ and surfaced only as a
  footnote.

With `--dryRun`, the script computes and prints the verdict and the markdown
report to stdout **without** reporting anything back — useful for local
iteration.

## Prerequisites

- **Node.js 18+**
- A `METICULOUS_API_TOKEN`.
- **The `react-component-renders` snapshot enabled for your project** — ask the
  Meticulous team to turn it on.
- **Source maps shipped by your replayed build** — required for component names
  and source locations to be meaningful.

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

The report links each degraded session back to the Meticulous app. Before
running, open `report-react-component-renders.ts` and set `PROJECT_URL` to your
project's base URL, replacing the `<organization>` and `<project>` placeholders
with the slugs from your project's URL in the Meticulous app:

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
- `WARN_PERCENT_INCREASE_THRESHOLD` / `WARN_MIN_DELTA_RENDERS` — relative and
  absolute growth that triggers a warning.
- `FAIL_PERCENT_INCREASE_THRESHOLD` / `FAIL_MIN_DELTA_RENDERS` — relative and
  absolute growth that requires acknowledgement.
- `MIN_RENDERS_FOR_ALARM` — minimum base render count before a component can alarm.
- `MAX_COMPONENTS` / `MAX_SESSIONS_PER_COMPONENT` — how much detail the report
  shows before truncating.
- `CHECK_ID` — stable identifier shown in the Meticulous UI.

## Type checking

```bash
npm run typecheck
```
