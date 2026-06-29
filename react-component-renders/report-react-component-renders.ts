/**
 * Example custom check that compares **per-component** React render counts on the
 * head replay against the base replay of a test run.
 *
 * Meticulous records a built-in `react-component-renders` snapshot during replay:
 * on each React commit it attributes the work to the components that actually
 * re-rendered, storing a cumulative per-component render count at each comparison
 * screenshot. This script totals each component's renders per session, aligns the
 * same component across base and head by its source location, and:
 *
 *   - warns (without requiring acknowledgement) when a component rendered at least
 *     WARN_PERCENT_INCREASE_THRESHOLD% AND WARN_MIN_DELTA_RENDERS more times than
 *     base;
 *   - warns and requires reviewer acknowledgement when a component rendered at
 *     least FAIL_PERCENT_INCREASE_THRESHOLD% AND FAIL_MIN_DELTA_RENDERS more times
 *     than base.
 *
 * Unlike a whole-app render count, this pinpoints *which* component started
 * rendering more — usually a missing/broken memoization, an unstable
 * prop/context value, or a new effect-driven render loop in that component.
 *
 * Components that rendered too few times on base (below MIN_RENDERS_FOR_ALARM),
 * and sessions whose components were recorded on only one of the two runs, are
 * excluded to keep noise out of the verdict.
 *
 * Run (after a test run has been triggered):
 *
 *   METICULOUS_API_TOKEN=... npm run report -- <testRunId>
 *
 * Pass `--dryRun` to compute and print the result without reporting it, or
 * `--commitSha <sha>` to resolve the test run from a commit instead.
 */
import {
  createClient,
  findTestRunByCommitForCustomChecks,
  findTestRunForCustomChecks,
  getSnapshotsFromTestRun,
  reportCustomCheckResults,
  type CustomCheckVerdict,
  type MeticulousClient,
  type ReportedCustomCheckResult,
  type Snapshot,
} from "@alwaysmeticulous/custom-checks";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

/**
 * `react-component-renders` is a built-in snapshot type Meticulous records during
 * replay. On each React commit it walks the committed fiber tree and attributes
 * the work to the components that actually re-rendered, recording a per-component
 * cumulative render count at each comparison screenshot. No application code is
 * required — Meticulous installs the hook itself — and it is a no-op on non-React
 * pages. It is a heavier companion to the whole-app `react-renders` snapshot and
 * is enabled separately; ask Meticulous to turn it on for your project. Do not
 * reuse this reserved name for snapshots you record yourself.
 */
const REACT_COMPONENT_RENDERS_SNAPSHOT_TYPE = "react-component-renders";

/** Stable id of this check, shown in the Meticulous UI. */
const CHECK_ID = "react-component-renders";

/**
 * Warn when a component's head render count is at least this many percent larger
 * than its base count (e.g. 50 -> head is >= 1.5x base), alongside the absolute
 * WARN_MIN_DELTA_RENDERS margin below. Per-component, per-instance counts are
 * larger and noisier than a single whole-app render total, so this bar is set
 * higher than you might use for a coarser metric. Tune to your app.
 */
const WARN_PERCENT_INCREASE_THRESHOLD = 50;

/**
 * Warn and require reviewer acknowledgement when a component's head render count
 * is at least this many percent larger than base, alongside FAIL_MIN_DELTA_RENDERS.
 * Strictly more severe than the warn threshold.
 */
const FAIL_PERCENT_INCREASE_THRESHOLD = 100;

/**
 * Absolute render-count growth (head - base) a component must also reach to warn.
 * Paired with WARN_PERCENT_INCREASE_THRESHOLD as a dual gate, so a percentage
 * alone can't fire loudly on small counts.
 */
const WARN_MIN_DELTA_RENDERS = 25;

/**
 * Absolute render-count growth a component must also reach to fail. Paired with
 * FAIL_PERCENT_INCREASE_THRESHOLD; strictly larger than WARN_MIN_DELTA_RENDERS.
 */
const FAIL_MIN_DELTA_RENDERS = 50;

/**
 * Minimum base render count a component must have for its growth to be considered
 * at all. Components that barely render have counts dominated by one-off mount
 * work, where small absolute swings are large percentages, so they are dropped
 * from the comparison.
 */
const MIN_RENDERS_FOR_ALARM = 25;

/** Most degraded components to detail in the report, to keep it readable. */
const MAX_COMPONENTS = 25;

/** Most degraded sessions to list under a single component, to keep it readable. */
const MAX_SESSIONS_PER_COMPONENT = 10;

/**
 * Base URL of your Meticulous project, used to link sessions in the markdown
 * report. You MUST replace the <organization> and <project> placeholders below
 * with your project's slugs (from its URL in the Meticulous app) before running
 * this check — the script refuses to run until you do.
 */
const PROJECT_URL =
  "https://app.meticulous.ai/projects/<organization>/<roject>";

const assertProjectUrlConfigured = (): void => {
  if (
    PROJECT_URL.includes("<organization>") ||
    PROJECT_URL.includes("<project>")
  ) {
    throw new Error(
      "PROJECT_URL still contains the <organization>/<project> placeholders. " +
        "Edit report-react-component-renders.ts and set PROJECT_URL to your " +
        "Meticulous project URL (e.g. https://app.meticulous.ai/projects/acme/web) " +
        "before running.",
    );
  }
};

/** Per-session, per-component comparison of base vs head total render count. */
interface ComponentComparison {
  sessionId: string;
  /** Short description of what the user did in the session, when recorded. */
  sessionDescription: string | null;
  /**
   * Stable identity used to align the component across base and head: its
   * resolved source location when known, else its display name.
   */
  componentKey: string;
  /** Display name if it survived minification, else null. */
  name: string | null;
  /** Resolved original source location if known, else null. */
  source: string | null;
  /** Total renders across the base run (max cumulative reading). */
  baseRenders: number;
  /** Total renders across the head run (max cumulative reading; 0 if absent). */
  headRenders: number;
  /** Head minus base. */
  delta: number;
  /** Increase relative to base, in percent. `Infinity` if base is 0. */
  percentIncrease: number;
}

/** Outcome of comparing every session's per-component render counts. */
interface ReactComponentRendersComparison {
  /** One entry per (session, component) pair eligible for comparison. */
  comparisons: ComponentComparison[];
  /** Sessions that had components on both runs (so were compared). */
  comparedSessionCount: number;
  /**
   * Sessions whose components were recorded on only one of the two runs (or
   * whose reads were all unrecognised), so there was nothing to compare.
   */
  incomparableSessionCount: number;
}

interface Args {
  testRunId: string | undefined;
  commitSha: string | undefined;
  apiToken: string | undefined;
  dryRun: boolean;
}

const main = async (): Promise<void> => {
  assertProjectUrlConfigured();
  const args = parseArgs();
  const client = createClient({
    apiToken: args.apiToken ?? process.env["METICULOUS_API_TOKEN"],
    appInfo: "custom-checks-example/react-component-renders",
  });

  const { testRun } = await resolveTestRun(client, args);

  let result: ReportedCustomCheckResult;
  try {
    result = await computeReactComponentRendersCheck(client, testRun.id);
  } catch (error) {
    if (args.dryRun) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await reportCustomCheckResults({
      client,
      testRunId: testRun.id,
      results: { status: "execution-error", error: message },
    });
    throw error;
  }

  if (args.dryRun) {
    printDryRun(testRun.id, result);
    return;
  }

  await reportCustomCheckResults({
    client,
    testRunId: testRun.id,
    results: { status: "complete", checks: [result] },
  });
  process.stdout.write(
    `Reported custom check "${CHECK_ID}" for test run ${testRun.id}: ${result.verdict}\n`,
  );
};

const parseArgs = (): Args => {
  const argv = hideBin(process.argv).filter((arg) => arg !== "--");
  const parsed = yargs(argv)
    .scriptName("report-react-component-renders")
    .usage(
      "$0 [testRunId] [options]\n\nReports the react-component-renders custom check for a test run.",
    )
    .option("commitSha", {
      type: "string",
      describe:
        "Resolve the test run from a commit SHA instead of passing its id",
    })
    .option("apiToken", {
      type: "string",
      describe: "API token (defaults to $METICULOUS_API_TOKEN)",
    })
    .option("dryRun", {
      type: "boolean",
      default: false,
      describe: "Compute and print the result without reporting it",
    })
    .help()
    .parseSync();

  return {
    testRunId: parsed._.length > 0 ? String(parsed._[0]) : undefined,
    commitSha: parsed.commitSha,
    apiToken: parsed.apiToken,
    dryRun: parsed.dryRun,
  };
};

const resolveTestRun = async (client: MeticulousClient, args: Args) => {
  const skipRegisteringExpectedCustomChecks = args.dryRun;

  if (args.testRunId) {
    return findTestRunForCustomChecks({
      client,
      testRunId: args.testRunId,
      skipRegisteringExpectedCustomChecks,
    });
  }

  if (args.commitSha) {
    return findTestRunByCommitForCustomChecks({
      client,
      commitSha: args.commitSha,
      skipRegisteringExpectedCustomChecks,
    });
  }

  throw new Error(
    "Pass a testRunId argument or --commitSha to identify the test run to report against.",
  );
};

/**
 * Fetches the `react-component-renders` snapshots for a (completed) test run,
 * compares each component's head vs base render count per session, and packages
 * the verdict, summary and markdown report into a result.
 */
const computeReactComponentRendersCheck = async (
  client: MeticulousClient,
  testRunId: string,
): Promise<ReportedCustomCheckResult> => {
  process.stderr.write(
    `Fetching ${REACT_COMPONENT_RENDERS_SNAPSHOT_TYPE} snapshots (this can take a while for large runs)...\n`,
  );
  const { baseSnapshots, headSnapshots } = await getSnapshotsFromTestRun({
    client,
    testRunId,
    snapshotTypes: [REACT_COMPONENT_RENDERS_SNAPSHOT_TYPE],
  });

  const { comparisons, comparedSessionCount, incomparableSessionCount } =
    compareSessions(baseSnapshots, headSnapshots);
  const verdict = computeVerdict(comparisons);

  return {
    checkId: CHECK_ID,
    verdict,
    summary: summarize(verdict, comparisons),
    report: {
      type: "markdown",
      markdown: buildReport({
        comparisons,
        comparedSessionCount,
        incomparableSessionCount,
        testRunId,
      }),
    },
  };
};

const printDryRun = (
  testRunId: string,
  result: ReportedCustomCheckResult,
): void => {
  process.stdout.write(
    `[dry run] Would report custom check "${result.checkId}" for test run ${testRunId}:\n` +
      `  verdict: ${result.verdict}\n` +
      `  summary: ${result.summary ?? ""}\n\n` +
      `${result.report.markdown}\n`,
  );
};

/**
 * Aligns each session's per-component render counts on base and head and, for
 * every component whose base count is at least MIN_RENDERS_FOR_ALARM, records the
 * head-vs-base growth. Components present only on head (no baseline) are not
 * flagged — a new component is not a regression of an existing one.
 */
const compareSessions = (
  baseSnapshots: Snapshot[],
  headSnapshots: Snapshot[],
): ReactComponentRendersComparison => {
  const baseBySession = groupBySession(baseSnapshots);
  const headBySession = groupBySession(headSnapshots);
  const sessionDescriptions = collectSessionDescriptionsById([
    ...baseSnapshots,
    ...headSnapshots,
  ]);

  const sessionIds = new Set([
    ...baseBySession.keys(),
    ...headBySession.keys(),
  ]);

  const comparisons: ComponentComparison[] = [];
  let comparedSessionCount = 0;
  let incomparableSessionCount = 0;

  for (const sessionId of sessionIds) {
    const baseComponents = totalRendersByComponent(
      baseBySession.get(sessionId) ?? [],
    );
    const headComponents = totalRendersByComponent(
      headBySession.get(sessionId) ?? [],
    );

    // Either side recorded nothing -> nothing to compare, so we drop the pair.
    if (baseComponents.size === 0 || headComponents.size === 0) {
      incomparableSessionCount += 1;
      continue;
    }
    comparedSessionCount += 1;

    for (const [key, base] of baseComponents) {
      if (base.renders < MIN_RENDERS_FOR_ALARM) {
        continue;
      }
      const head = headComponents.get(key);
      const headRenders = head?.renders ?? 0;
      const delta = headRenders - base.renders;
      comparisons.push({
        sessionId,
        sessionDescription: sessionDescriptions.get(sessionId) ?? null,
        componentKey: key,
        name: base.name ?? head?.name ?? null,
        source: base.source ?? head?.source ?? null,
        baseRenders: base.renders,
        headRenders,
        delta,
        // base.renders is always >= MIN_RENDERS_FOR_ALARM here, so the `=== 0`
        // arm is unreachable today; kept defensively if that floor is lowered.
        percentIncrease:
          base.renders === 0
            ? headRenders > 0
              ? Infinity
              : 0
            : (delta / base.renders) * 100,
      });
    }
  }

  // Surface the component whose render count grew the most first; ties break on
  // the percentage, then session id, then component key for a stable order.
  comparisons.sort(
    (a, b) =>
      b.delta - a.delta ||
      b.percentIncrease - a.percentIncrease ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.componentKey.localeCompare(b.componentKey),
  );

  return { comparisons, comparedSessionCount, incomparableSessionCount };
};

/** Buckets the component-render snapshots by session id. */
const groupBySession = (snapshots: Snapshot[]): Map<string, Snapshot[]> => {
  const bySession = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.type !== REACT_COMPONENT_RENDERS_SNAPSHOT_TYPE) {
      continue;
    }
    const existing = bySession.get(snapshot.sessionId);
    if (existing) {
      existing.push(snapshot);
    } else {
      bySession.set(snapshot.sessionId, [snapshot]);
    }
  }
  return bySession;
};

/** First non-null `sessionDescription` per `sessionId` across the snapshots. */
const collectSessionDescriptionsById = (
  snapshots: Snapshot[],
): Map<string, string | null> => {
  const bySession = new Map<string, string | null>();
  for (const snapshot of snapshots) {
    const description = snapshot.sessionDescription ?? null;
    const existing = bySession.get(snapshot.sessionId);
    if (existing === undefined) {
      bySession.set(snapshot.sessionId, description);
      continue;
    }
    if (existing === null && description !== null) {
      bySession.set(snapshot.sessionId, description);
    }
  }
  return bySession;
};

/** One component's entry in a `react-component-renders` snapshot's `data`. */
interface ComponentEntry {
  name?: unknown;
  source?: unknown;
  commits?: unknown;
}

interface ReactComponentRendersSnapshotData {
  components?: unknown;
}

/** Total renders for one component across one replay of a session. */
interface ComponentRenderTotal {
  /** Display name if known, else null. */
  name: string | null;
  /** Resolved source location if known, else null. */
  source: string | null;
  /** Largest cumulative render count seen (the recorded counter is monotonic). */
  renders: number;
}

/**
 * Computes the total render count per component across the given snapshots, keyed
 * by the component's identity (its `source` when present, else its `name`).
 *
 * Two aggregation rules apply, matching how the counts are produced:
 *  - *Within* a snapshot, entries sharing a key are summed. After source-map
 *    resolution a snapshot can carry several distinct components that collapse to
 *    the same key (e.g. two unresolved components with the same display name and
 *    `source: null`); they are different components, so their counts add.
 *  - *Across* snapshots, the per-key total is the maximum, because the cumulative
 *    count is streamed per stage — the max is the final total, robust to a
 *    dropped sample.
 *
 * Malformed entries are ignored (the data crosses a JSON boundary).
 */
const totalRendersByComponent = (
  snapshots: Snapshot[],
): Map<string, ComponentRenderTotal> => {
  const byKey = new Map<string, ComponentRenderTotal>();
  for (const snapshot of snapshots) {
    const { components } = readData(snapshot);
    if (!Array.isArray(components)) {
      continue;
    }
    // Sum distinct same-key components within this snapshot first...
    const perSnapshot = new Map<string, ComponentRenderTotal>();
    for (const entry of components as ComponentEntry[]) {
      const renders = knownCount(entry.commits);
      if (renders === null) {
        continue;
      }
      const name = typeof entry.name === "string" ? entry.name : null;
      const source = typeof entry.source === "string" ? entry.source : null;
      const key = source ?? name;
      if (key === null) {
        continue;
      }
      const existing = perSnapshot.get(key);
      if (existing === undefined) {
        perSnapshot.set(key, { name, source, renders });
      } else {
        existing.renders += renders;
        existing.name = existing.name ?? name;
        existing.source = existing.source ?? source;
      }
    }
    // ...then take the max of those per-snapshot totals across snapshots.
    for (const [key, total] of perSnapshot) {
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, total);
      } else if (total.renders > existing.renders) {
        existing.renders = total.renders;
        existing.name = existing.name ?? total.name;
        existing.source = existing.source ?? total.source;
      }
    }
  }
  return byKey;
};

const readData = (snapshot: Snapshot): ReactComponentRendersSnapshotData =>
  (snapshot.data ?? {}) as ReactComponentRendersSnapshotData;

/** A non-negative finite render count, else `null` (missing/malformed reading). */
const knownCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value >= 0 ? value : null;
};

const computeVerdict = (
  comparisons: ComponentComparison[],
): CustomCheckVerdict => {
  if (comparisons.some(isFailing)) {
    return "warn-and-require-user-ack";
  }
  if (comparisons.some(isWarning)) {
    return "warn-without-requiring-user-ack";
  }
  return "pass";
};

// Low-count components are dropped upstream (see `compareSessions`), so every
// comparison here has a base total of at least MIN_RENDERS_FOR_ALARM.

// A regression must clear BOTH the relative and the absolute margin (a dual
// gate); see WARN_MIN_DELTA_RENDERS for why neither alone is enough.
const isFailing = (comparison: ComponentComparison): boolean =>
  meetsRelativeThreshold(comparison, FAIL_PERCENT_INCREASE_THRESHOLD) &&
  meetsAbsoluteThreshold(comparison, FAIL_MIN_DELTA_RENDERS);

const isWarning = (comparison: ComponentComparison): boolean =>
  !isFailing(comparison) &&
  meetsRelativeThreshold(comparison, WARN_PERCENT_INCREASE_THRESHOLD) &&
  meetsAbsoluteThreshold(comparison, WARN_MIN_DELTA_RENDERS);

/** True for any comparison that contributes to the verdict (warn or fail). */
const isAlarming = (comparison: ComponentComparison): boolean =>
  isFailing(comparison) || isWarning(comparison);

// Integer comparison of headRenders/baseRenders >= 1 + threshold/100, so an
// exact threshold increase warns instead of being lost to floating-point error.
const meetsRelativeThreshold = (
  comparison: ComponentComparison,
  thresholdPercent: number,
): boolean =>
  comparison.baseRenders > 0 &&
  comparison.headRenders * 100 >=
    comparison.baseRenders * (100 + thresholdPercent);

const meetsAbsoluteThreshold = (
  comparison: ComponentComparison,
  minDeltaRenders: number,
): boolean => comparison.delta >= minDeltaRenders;

/** Distinct sessions that own at least one component matching `predicate`. */
const distinctSessionCount = (
  comparisons: ComponentComparison[],
  predicate: (comparison: ComponentComparison) => boolean,
): number =>
  new Set(
    comparisons.filter(predicate).map((comparison) => comparison.sessionId),
  ).size;

const summarize = (
  verdict: CustomCheckVerdict,
  comparisons: ComponentComparison[],
): string => {
  switch (verdict) {
    case "warn-and-require-user-ack": {
      // Count only the failing components/sessions, not warn-level ones, so the
      // headline matches the fail threshold it cites.
      const count = comparisons.filter(isFailing).length;
      return `${count} component(s) with ${FAIL_PERCENT_INCREASE_THRESHOLD}%+ more React renders across ${distinctSessionCount(comparisons, isFailing)} session(s)`;
    }
    case "warn-without-requiring-user-ack": {
      const count = comparisons.filter(isWarning).length;
      return `${count} component(s) with ${WARN_PERCENT_INCREASE_THRESHOLD}%+ more React renders across ${distinctSessionCount(comparisons, isWarning)} session(s)`;
    }
    case "pass":
      return "No component's React render count grew past the thresholds";
  }
};

/**
 * A component that grew past a threshold in at least one session, together with
 * the sessions it grew in (worst first) and a couple of aggregates used to rank
 * components against each other.
 */
interface ComponentGroup {
  componentKey: string;
  /** Display name if it survived minification, else null. */
  name: string | null;
  /** Resolved original source location if known, else null. */
  source: string | null;
  /** Alarming session comparisons for this component, most degraded first. */
  sessions: ComponentComparison[];
  /** Sum of head - base render growth across the alarming sessions. */
  totalDelta: number;
  /** Largest relative increase across the alarming sessions (ranking tiebreak). */
  maxPercentIncrease: number;
  /** True when at least one session crossed the fail threshold. */
  failing: boolean;
}

/**
 * Renders the markdown report shown in the Meticulous UI, giving developers a
 * **per-component** view in two parts: a compact summary table with one row per
 * degraded component (most-degraded first) to scan at a glance, followed by a
 * per-component breakdown where each component's section lists the sessions it
 * degraded in (worst first), linked to their view within the test run, with the
 * base->head render counts for each.
 */
const buildReport = ({
  comparisons,
  comparedSessionCount,
  incomparableSessionCount,
  testRunId,
}: {
  comparisons: ComponentComparison[];
  comparedSessionCount: number;
  incomparableSessionCount: number;
  testRunId: string;
}): string => {
  const lines: string[] = [
    "# React component renders",
    "",
    "This check breaks the React render count down **per component**: on each " +
      "commit Meticulous attributes the work to the components that re-rendered, " +
      "then this check compares each component's head total against its base " +
      "total, per session. A component is matched across runs by its source " +
      "location (so it lines up even when names are minified differently), and " +
      "counted once per instance per commit. A component warns when its render " +
      `count grew by at least ${WARN_PERCENT_INCREASE_THRESHOLD}% and ` +
      `${WARN_MIN_DELTA_RENDERS} renders, and fails (requires acknowledgement) ` +
      `when it grew by at least ${FAIL_PERCENT_INCREASE_THRESHOLD}% and ` +
      `${FAIL_MIN_DELTA_RENDERS} renders — both a relative and an absolute ` +
      "margin must be met. Components that rendered too few times on base are " +
      "dropped as too noisy.",
    "",
    "_Thresholds are configurable — tune them to your app's expected render counts._",
    "",
  ];

  const alarming = comparisons.filter(isAlarming);

  if (alarming.length === 0) {
    lines.push("No component's React render count grew past the thresholds.");
  } else {
    const groups = groupByComponent(alarming);
    // Build session labels once, over the distinct sessions in the order they
    // first appear in the report, so a session that degraded several components
    // keeps one stable label throughout.
    const sessionLabels = buildSessionLabels(groups);
    const sessionCount = new Set(alarming.map((c) => c.sessionId)).size;

    const shownGroups = groups.slice(0, MAX_COMPONENTS);

    lines.push(
      "## Summary",
      "",
      `${groups.length} component(s) grew past a threshold across ` +
        `${sessionCount} session(s), most degraded first.`,
      "",
    );

    appendSummaryTable(lines, shownGroups);

    if (groups.length > MAX_COMPONENTS) {
      lines.push(
        `_…and ${groups.length - MAX_COMPONENTS} more component(s) past a threshold (not shown below)._`,
        "",
      );
    }

    lines.push("## Per-component breakdown", "");

    for (const group of shownGroups) {
      appendComponentSection(lines, group, sessionLabels, testRunId);
    }
  }

  if (incomparableSessionCount > 0) {
    lines.push(
      "",
      `_${incomparableSessionCount} session(s) recorded component renders on ` +
        "only one of the two runs and were excluded from the comparison " +
        `(${comparedSessionCount} session(s) compared)._`,
    );
  }

  return lines.join("\n").trimEnd();
};

/**
 * Groups the alarming (session, component) comparisons by component, ranking the
 * components by how much they degraded overall (total render growth across the
 * sessions they grew in, then the largest relative increase) and, within each,
 * the sessions by how much they degraded that component.
 */
const groupByComponent = (
  alarming: ComponentComparison[],
): ComponentGroup[] => {
  const byKey = new Map<string, ComponentGroup>();
  for (const comparison of alarming) {
    const existing = byKey.get(comparison.componentKey);
    if (existing) {
      existing.sessions.push(comparison);
      existing.totalDelta += comparison.delta;
      existing.maxPercentIncrease = Math.max(
        existing.maxPercentIncrease,
        comparison.percentIncrease,
      );
      existing.failing = existing.failing || isFailing(comparison);
      existing.name = existing.name ?? comparison.name;
      existing.source = existing.source ?? comparison.source;
    } else {
      byKey.set(comparison.componentKey, {
        componentKey: comparison.componentKey,
        name: comparison.name,
        source: comparison.source,
        sessions: [comparison],
        totalDelta: comparison.delta,
        maxPercentIncrease: comparison.percentIncrease,
        failing: isFailing(comparison),
      });
    }
  }

  const groups = [...byKey.values()];
  for (const group of groups) {
    // Worst-degraded session first; ties break on the percentage, then the
    // session id for a stable order.
    group.sessions.sort(
      (a, b) =>
        b.delta - a.delta ||
        b.percentIncrease - a.percentIncrease ||
        a.sessionId.localeCompare(b.sessionId),
    );
  }
  // Most-degraded component first; ties break on the largest relative increase,
  // then the component key for a stable order.
  groups.sort(
    (a, b) =>
      b.totalDelta - a.totalDelta ||
      b.maxPercentIncrease - a.maxPercentIncrease ||
      a.componentKey.localeCompare(b.componentKey),
  );
  return groups;
};

/**
 * Appends the compact summary table — one row per degraded component, in the
 * same most-degraded-first order as the breakdown below — so a reader can scan
 * the components before drilling in.
 */
const appendSummaryTable = (
  lines: string[],
  groups: readonly ComponentGroup[],
): void => {
  lines.push(
    "| Component | Status | Sessions | Total Δ renders | Worst increase |",
    "| --- | :---: | ---: | ---: | ---: |",
  );
  for (const group of groups) {
    const tag = group.failing ? "❌" : "⚠️";
    lines.push(
      `| ${describeComponent(group)} | ${tag} | ${group.sessions.length} | ` +
        `${formatDelta(group.totalDelta)} | ` +
        `${formatPercent(group.maxPercentIncrease)} |`,
    );
  }
  lines.push("");
};

/** Appends one component's heading and its per-session table to `lines`. */
const appendComponentSection = (
  lines: string[],
  group: ComponentGroup,
  sessionLabels: ReadonlyMap<string, string>,
  testRunId: string,
): void => {
  const tag = group.failing ? "❌" : "⚠️";
  lines.push(
    `### ${describeComponent(group)} ${tag}`,
    "",
    `Grew by ${formatDelta(group.totalDelta)} renders across ` +
      `${group.sessions.length} session(s).`,
    "",
    "| Session | Base renders | Head renders | Δ | Increase |",
    "| --- | ---: | ---: | ---: | ---: |",
  );

  for (const session of group.sessions.slice(0, MAX_SESSIONS_PER_COMPONENT)) {
    const label = sessionLabels.get(session.sessionId) ?? session.sessionId;
    const link = formatSessionLink(testRunId, session.sessionId, label);
    const sessionTag = isFailing(session) ? "❌" : "⚠️";
    lines.push(
      `| ${link} ${sessionTag} | ${session.baseRenders} | ` +
        `${session.headRenders} | ${formatDelta(session.delta)} | ` +
        `${formatPercent(session.percentIncrease)} |`,
    );
  }

  if (group.sessions.length > MAX_SESSIONS_PER_COMPONENT) {
    lines.push(
      "",
      `_…and ${group.sessions.length - MAX_SESSIONS_PER_COMPONENT} more ` +
        "session(s) for this component (omitted)._",
    );
  }

  lines.push("");
};

/**
 * Builds a stable `sessionId` -> display label map over the sessions in the order
 * they first appear in the report (component by component, worst session first),
 * so labels are deterministic and a session reused across components is labelled
 * once.
 */
const buildSessionLabels = (
  groups: readonly ComponentGroup[],
): ReadonlyMap<string, string> => {
  const sessionsInDisplayOrder: SessionLabelInput[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const session of group.sessions) {
      if (seen.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      sessionsInDisplayOrder.push({
        sessionId: session.sessionId,
        sessionDescription: session.sessionDescription,
      });
    }
  }
  return buildSessionDisplayLabels(sessionsInDisplayOrder);
};

interface SessionLabelInput {
  sessionId: string;
  sessionDescription: string | null;
}

/**
 * Builds a `sessionId` -> display label map for sessions listed in report order.
 * Uses each session's `sessionDescription` when present (disambiguating
 * duplicates with a `(1)`, `(2)`, … suffix); otherwise falls back to `session1`,
 * `session2`, … by position.
 */
const buildSessionDisplayLabels = (
  sessionsInDisplayOrder: readonly SessionLabelInput[],
): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  const countByDescription = new Map<string, number>();

  for (const { sessionDescription } of sessionsInDisplayOrder) {
    if (sessionDescription != null) {
      countByDescription.set(
        sessionDescription,
        (countByDescription.get(sessionDescription) ?? 0) + 1,
      );
    }
  }

  const indexByDescription = new Map<string, number>();
  sessionsInDisplayOrder.forEach((session, index) => {
    const { sessionId, sessionDescription } = session;
    if (sessionDescription != null) {
      if ((countByDescription.get(sessionDescription) ?? 0) <= 1) {
        labels.set(sessionId, sessionDescription);
        return;
      }
      const disambiguator =
        (indexByDescription.get(sessionDescription) ?? 0) + 1;
      indexByDescription.set(sessionDescription, disambiguator);
      labels.set(sessionId, `${sessionDescription} (${disambiguator})`);
      return;
    }
    labels.set(sessionId, `session${index + 1}`);
  });

  return labels;
};

/** Markdown link to a session's view within this test run. */
const formatSessionLink = (
  testRunId: string,
  sessionId: string,
  label: string,
): string =>
  `[${escapeMarkdownLinkLabel(label)}](${sessionUrl(testRunId, sessionId)})`;

const escapeMarkdownLinkLabel = (label: string): string =>
  label.replaceAll("[", "\\[").replaceAll("]", "\\]");

const sessionUrl = (testRunId: string, sessionId: string): string =>
  `${PROJECT_URL}/test-runs/${testRunId}/sessions/${sessionId}`;

/** A readable identity for a component: its name, its source, or both. */
const describeComponent = (component: {
  name: string | null;
  source: string | null;
}): string => {
  if (component.name && component.source) {
    return `\`${component.name}\` (${component.source})`;
  }
  if (component.name) {
    return `\`${component.name}\``;
  }
  return component.source ?? "(unknown component)";
};

const formatDelta = (delta: number): string =>
  `${delta >= 0 ? "+" : ""}${delta}`;

const formatPercent = (percent: number): string => {
  if (!Number.isFinite(percent)) {
    // A component with no measured renders on base has no finite percentage.
    return "new";
  }
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
