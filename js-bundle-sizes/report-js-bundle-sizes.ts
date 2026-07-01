/**
 * Example custom check that compares the total JavaScript bundle size each
 * session loaded on the head replay against the base replay of a test run:
 *
 *   - warns (without requiring acknowledgement) when a session's total grew by
 *     at least WARN_PERCENT_INCREASE_THRESHOLD% (or loaded new JS with no base
 *     baseline);
 *   - warns and requires reviewer acknowledgement when a session's total grew by
 *     at least FAIL_PERCENT_INCREASE_THRESHOLD%.
 *
 * Each bundle is sized from the served response (its `content-length`, or the
 * served body when that header is absent) and counted once per URL, so a chunk
 * loaded twice is not double-counted. Session pairs where neither side loaded at
 * least MIN_BYTES_FOR_ALARM of JavaScript are excluded to keep low-size noise out
 * of the verdict.
 *
 * The markdown report is a single summary table: one row per session whose total
 * JS bundle size grew, with its base/head totals, delta and percentage — linked
 * back to the session's view within the test run.
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
 * `js-bundle-sizes` is a built-in snapshot type Meticulous records during
 * replay: one entry per JavaScript (script) load, holding the served URL and its
 * size in bytes. No application code is required — ask Meticulous to turn it on
 * for your project. Do not reuse this reserved name for snapshots you record
 * yourself.
 */
const JS_BUNDLE_SIZES_SNAPSHOT_TYPE = "js-bundle-sizes";

/** Stable id of this check, shown in the Meticulous UI. */
const CHECK_ID = "js-bundle-sizes";

/**
 * Warn when a session's total head bundle size is at least this many percent
 * larger than base (10 -> head is >= 1.1x base).
 */
const WARN_PERCENT_INCREASE_THRESHOLD = 10;

/**
 * Fail (require acknowledgement) when a session's total head bundle size is at
 * least this many percent larger than base (20 -> head is >= 1.2x base). Strictly
 * more severe than WARN_PERCENT_INCREASE_THRESHOLD.
 */
const FAIL_PERCENT_INCREASE_THRESHOLD = 20;

/**
 * Don't warn or fail on session pairs where neither side loaded at least this
 * many bytes of JavaScript. Below this floor a large relative swing is only a
 * handful of KB — a single small chunk shifting — rather than a real bundle-size
 * regression, and the percentages are misleading (4 KB -> 8 KB = +100%). Sized
 * to "a non-trivial amount of app JavaScript".
 */
const MIN_BYTES_FOR_ALARM = 50 * 1024;

/**
 * When the verdict is pass, at most this many non-threshold sessions (sorted by
 * largest growth first) still appear in the summary table, so a reader can see
 * the biggest movers even when nothing crossed a threshold.
 */
const MAX_PASSED_SESSIONS_IN_TABLE = 5;

/**
 * Base URL of your Meticulous project, used to link sessions in the markdown
 * report. You MUST replace the <organization> and <project> placeholders below
 * with your project's slugs (from its URL in the Meticulous app) before running
 * this check — the script refuses to run until you do.
 */
const PROJECT_URL =
  "https://app.meticulous.ai/projects/<organization>/<project>";

const assertProjectUrlConfigured = (): void => {
  if (
    PROJECT_URL.includes("<organization>") ||
    PROJECT_URL.includes("<project>")
  ) {
    throw new Error(
      "PROJECT_URL still contains the <organization>/<project> placeholders. " +
        "Edit report-js-bundle-sizes.ts and set PROJECT_URL to your Meticulous " +
        "project URL (e.g. https://app.meticulous.ai/projects/acme/web) before running.",
    );
  }
};

/**
 * The fields of a built-in `js-bundle-sizes` snapshot's `data` we read. The SDK
 * types `Snapshot["data"]` as `unknown`, so we declare just the minimal shape
 * here. `sizeInBytes` is `-1` when the served bundle size could not be
 * determined.
 */
interface JsBundleSizeSnapshotData {
  url?: string;
  sizeInBytes?: number;
  status?: number;
}

/** The largest known byte size per distinct bundle URL within one session. */
interface SessionBundleSizes {
  /** Max known size (bytes) for each URL that reported a size at least once. */
  bytesByUrl: Map<string, number>;
  /**
   * URLs that loaded but never reported a size, so their bytes are unknown and
   * excluded from the totals. Surfaced as a report footnote.
   */
  unknownUrlCount: number;
}

/** Per-session comparison of base vs head total JS bundle bytes. */
interface SessionComparison {
  sessionId: string;
  /** Short description of what the user did in the session, when recorded. */
  sessionDescription: string | null;
  /** Sum of the (deduped) known bundle bytes loaded on the base run. */
  baseBytes: number;
  /** Sum of the (deduped) known bundle bytes loaded on the head run. */
  headBytes: number;
  /** Head minus base, in bytes. */
  delta: number;
  /** Increase relative to base, in percent. `Infinity` if base is 0. */
  percentIncrease: number;
}

/** Outcome of comparing every session's base vs head total bundle size. */
interface BundleSizesComparison {
  comparisons: SessionComparison[];
  /**
   * Bundles (across all compared sessions, base and head) that loaded without a
   * known size, so their bytes were left out of the totals. Surfaced as a
   * report footnote.
   */
  unknownBundleCount: number;
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
    appInfo: "custom-checks-example/js-bundle-sizes",
  });

  const { testRun } = await resolveTestRun(client, args);

  let result: ReportedCustomCheckResult;
  try {
    result = await computeJsBundleSizesCheck(client, testRun.id);
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
    .scriptName("report-js-bundle-sizes")
    .usage(
      "$0 [testRunId] [options]\n\nReports the js-bundle-sizes custom check for a test run.",
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
 * Fetches the `js-bundle-sizes` snapshots for a (completed) test run, compares
 * each session's head vs base total JavaScript bundle size, and packages the
 * verdict, summary and markdown report into a result.
 */
const computeJsBundleSizesCheck = async (
  client: MeticulousClient,
  testRunId: string,
): Promise<ReportedCustomCheckResult> => {
  process.stderr.write(
    `Fetching ${JS_BUNDLE_SIZES_SNAPSHOT_TYPE} snapshots (this can take a while for large runs)...\n`,
  );
  const { baseSnapshots, headSnapshots } = await getSnapshotsFromTestRun({
    client,
    testRunId,
    snapshotTypes: [JS_BUNDLE_SIZES_SNAPSHOT_TYPE],
  });

  const { comparisons, unknownBundleCount } = compareSessions(
    baseSnapshots,
    headSnapshots,
  );
  const verdict = computeVerdict(comparisons);

  return {
    checkId: CHECK_ID,
    verdict,
    summary: summarize(verdict, comparisons),
    report: {
      type: "markdown",
      markdown: buildReport({
        verdict,
        comparisons,
        unknownBundleCount,
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
 * Totals the (deduped) JavaScript bundle bytes each session loaded on base and
 * head, aligned by `sessionId`. Every session present in *either* replay is
 * compared, except sessions that ran only on head (no base replay): they cannot
 * regress against a non-existent baseline, so they are omitted entirely.
 */
const compareSessions = (
  baseSnapshots: Snapshot[],
  headSnapshots: Snapshot[],
): BundleSizesComparison => {
  const baseSessionIds = collectSessionIdsWithBundleSnapshots(baseSnapshots);
  const baseBySession = groupBundlesBySession(baseSnapshots);
  const headBySession = groupBundlesBySession(headSnapshots);
  const sessionDescriptions = collectSessionDescriptionsById([
    ...baseSnapshots,
    ...headSnapshots,
  ]);

  const sessionIds = new Set([
    ...baseBySession.keys(),
    ...headBySession.keys(),
  ]);

  const comparisons: SessionComparison[] = [];
  let unknownBundleCount = 0;

  for (const sessionId of sessionIds) {
    if (!baseSessionIds.has(sessionId)) {
      continue;
    }
    const baseSizes = baseBySession.get(sessionId) ?? emptySizes();
    const headSizes = headBySession.get(sessionId) ?? emptySizes();
    unknownBundleCount += baseSizes.unknownUrlCount + headSizes.unknownUrlCount;

    const baseBytes = totalBytes(baseSizes);
    const headBytes = totalBytes(headSizes);
    comparisons.push({
      sessionId,
      sessionDescription: sessionDescriptions.get(sessionId) ?? null,
      baseBytes,
      headBytes,
      delta: headBytes - baseBytes,
      percentIncrease:
        baseBytes === 0
          ? headBytes > 0
            ? Infinity
            : 0
          : ((headBytes - baseBytes) / baseBytes) * 100,
    });
  }

  // Surface the session whose bundle size grew the most first (delta
  // descending). Ties break on the percentage increase, then sessionId for a
  // stable order.
  comparisons.sort(
    (a, b) =>
      b.delta - a.delta ||
      b.percentIncrease - a.percentIncrease ||
      a.sessionId.localeCompare(b.sessionId),
  );

  return { comparisons, unknownBundleCount };
};

/** Buckets the bundle-load snapshots by session, deduping each side per URL. */
const groupBundlesBySession = (
  snapshots: Snapshot[],
): Map<string, SessionBundleSizes> => {
  const bySession = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    if (snapshot.type !== JS_BUNDLE_SIZES_SNAPSHOT_TYPE) {
      continue;
    }
    const existing = bySession.get(snapshot.sessionId);
    if (existing) {
      existing.push(snapshot);
    } else {
      bySession.set(snapshot.sessionId, [snapshot]);
    }
  }

  const sizesBySession = new Map<string, SessionBundleSizes>();
  for (const [sessionId, sessionSnapshots] of bySession) {
    sizesBySession.set(sessionId, collectSessionBundleSizes(sessionSnapshots));
  }
  return sizesBySession;
};

/**
 * Collapses a session's raw bundle-load snapshots to the largest known size per
 * distinct URL. A chunk can be loaded more than once in a session (e.g. a
 * `<link rel="modulepreload">` plus the executed `<script>`, or across stages
 * after a cache miss); summing every load would double-count it, so we dedupe by
 * URL and keep the largest reported size.
 */
const collectSessionBundleSizes = (
  snapshots: Snapshot[],
): SessionBundleSizes => {
  const bytesByUrl = new Map<string, number>();
  const urlsWithKnownSize = new Set<string>();
  const urlsSeen = new Set<string>();

  for (const snapshot of snapshots) {
    const data = bundleLoadData(snapshot);
    const { url } = data;
    if (!url) {
      continue;
    }
    urlsSeen.add(url);
    const size = knownSizeInBytes(data);
    if (size === null) {
      continue;
    }
    urlsWithKnownSize.add(url);
    const existing = bytesByUrl.get(url);
    if (existing === undefined || size > existing) {
      bytesByUrl.set(url, size);
    }
  }

  return {
    bytesByUrl,
    unknownUrlCount: urlsSeen.size - urlsWithKnownSize.size,
  };
};

/** Sum of all known bundle bytes in a {@link SessionBundleSizes}. */
const totalBytes = (sizes: SessionBundleSizes): number => {
  let total = 0;
  for (const bytes of sizes.bytesByUrl.values()) {
    total += bytes;
  }
  return total;
};

/** Reads the bundle-load `data` off a snapshot (typed as `unknown`). */
const bundleLoadData = (snapshot: Snapshot): JsBundleSizeSnapshotData =>
  (snapshot.data ?? {}) as JsBundleSizeSnapshotData;

/** The known size of a bundle load in bytes, or `null` when not reported (-1). */
const knownSizeInBytes = (data: JsBundleSizeSnapshotData): number | null => {
  const { sizeInBytes } = data;
  if (typeof sizeInBytes !== "number" || !Number.isFinite(sizeInBytes)) {
    return null;
  }
  // -1 is the collector's sentinel for "size could not be determined"; any
  // other negative value is equally untrustworthy.
  return sizeInBytes >= 0 ? sizeInBytes : null;
};

/** Session ids that have at least one js-bundle-sizes snapshot on the base run. */
const collectSessionIdsWithBundleSnapshots = (
  snapshots: Snapshot[],
): Set<string> => {
  const sessionIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.type === JS_BUNDLE_SIZES_SNAPSHOT_TYPE) {
      sessionIds.add(snapshot.sessionId);
    }
  }
  return sessionIds;
};

const emptySizes = (): SessionBundleSizes => ({
  bytesByUrl: new Map(),
  unknownUrlCount: 0,
});

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

// Suppress both warn and fail on session pairs where neither side cleared the
// byte floor: at tiny JS totals a large relative swing is a few KB of noise and
// the percentages are misleading (4 KB -> 8 KB = +100%).
const hasEnoughBytes = (comparison: SessionComparison): boolean =>
  Math.max(comparison.baseBytes, comparison.headBytes) >= MIN_BYTES_FOR_ALARM;

// Integer comparison of headBytes/baseBytes >= 1 + threshold/100, so an exact
// threshold increase (e.g. 100 KB -> 120 KB at 20%) fails instead of being lost
// to floating-point error. A session with no known JS on base has no meaningful
// baseline to fail against, so it is excluded here.
const isFailing = (comparison: SessionComparison): boolean =>
  hasEnoughBytes(comparison) &&
  comparison.baseBytes > 0 &&
  comparison.headBytes * 100 >=
    comparison.baseBytes * (100 + FAIL_PERCENT_INCREASE_THRESHOLD);

// Head-only sessions are excluded upstream (see `compareSessions`), so every
// comparison here has a base replay. A session that loaded no known JS on base
// (baseBytes === 0) can still warn when head ships enough new JS to clear the
// byte floor. Same integer arithmetic as `isFailing` so the warn boundary is
// exact.
const isWarning = (comparison: SessionComparison): boolean => {
  if (!hasEnoughBytes(comparison) || comparison.delta <= 0) {
    return false;
  }
  if (isFailing(comparison)) {
    return false;
  }
  if (comparison.baseBytes === 0) {
    return true;
  }
  return (
    comparison.headBytes * 100 >=
    comparison.baseBytes * (100 + WARN_PERCENT_INCREASE_THRESHOLD)
  );
};

/** True for any session that contributes to the verdict (warn or fail). */
const isAlarming = (comparison: SessionComparison): boolean =>
  isFailing(comparison) || isWarning(comparison);

const computeVerdict = (
  comparisons: SessionComparison[],
): CustomCheckVerdict => {
  if (comparisons.some(isFailing)) {
    return "warn-and-require-user-ack";
  }
  if (comparisons.some(isWarning)) {
    return "warn-without-requiring-user-ack";
  }
  return "pass";
};

/** Sessions that were compared but did not cross warn/fail thresholds. */
const countSessionsWithoutIssue = (comparisons: SessionComparison[]): number =>
  comparisons.filter((comparison) => !isAlarming(comparison)).length;

const summarize = (
  verdict: CustomCheckVerdict,
  comparisons: SessionComparison[],
): string => {
  const withoutIssueSuffix =
    verdict === "pass"
      ? ""
      : `; ${countSessionsWithoutIssue(comparisons)} session(s) did not create an issue`;

  switch (verdict) {
    case "warn-and-require-user-ack": {
      const count = comparisons.filter(isFailing).length;
      return `${count} session(s) with ${FAIL_PERCENT_INCREASE_THRESHOLD}%+ larger JS bundles${withoutIssueSuffix}`;
    }
    case "warn-without-requiring-user-ack": {
      const warnings = comparisons.filter(isWarning);
      const newBundleWarningCount = warnings.filter(
        (comparison) => comparison.baseBytes === 0,
      ).length;
      if (newBundleWarningCount === warnings.length) {
        return `${warnings.length} session(s) loading JS bundles with no base baseline${withoutIssueSuffix}`;
      }
      if (newBundleWarningCount === 0) {
        return `${warnings.length} session(s) with ${WARN_PERCENT_INCREASE_THRESHOLD}%+ larger JS bundles${withoutIssueSuffix}`;
      }
      return `${warnings.length} session(s) with ${WARN_PERCENT_INCREASE_THRESHOLD}%+ larger or newly-loaded JS bundles${withoutIssueSuffix}`;
    }
    case "pass":
      return "No session's JS bundle size grew past the thresholds";
  }
};

const headMultiplier = (percentIncreaseThreshold: number): string =>
  (1 + percentIncreaseThreshold / 100).toFixed(1);

/**
 * Renders the markdown report shown in the Meticulous UI: a short explanation
 * followed by a single summary table with one row per session whose total JS
 * bundle size grew on head, each linked back to its view within the test run.
 */
const buildReport = ({
  verdict,
  comparisons,
  unknownBundleCount,
  testRunId,
}: {
  verdict: CustomCheckVerdict;
  comparisons: SessionComparison[];
  unknownBundleCount: number;
  testRunId: string;
}): string => {
  const warnMultiplier = headMultiplier(WARN_PERCENT_INCREASE_THRESHOLD);
  const failMultiplier = headMultiplier(FAIL_PERCENT_INCREASE_THRESHOLD);

  const lines: string[] = [
    "# JS bundle sizes",
    "",
    "This check sums the JavaScript (script) bytes each session loaded on this " +
      "test run and compares it against the base. Each bundle is sized from the " +
      "served response (its `content-length`, or the served body when that " +
      "header is absent) and counted once per URL (the largest reported size " +
      "wins, so a chunk loaded twice isn't double-counted). It " +
      `warns when a session's total grew by at least ${WARN_PERCENT_INCREASE_THRESHOLD}% ` +
      `(head >= ${warnMultiplier}x base) and fails when it grew by at least ${FAIL_PERCENT_INCREASE_THRESHOLD}% ` +
      `(head >= ${failMultiplier}x base). Session pairs where neither side loaded ` +
      `${formatBytes(MIN_BYTES_FOR_ALARM)} of JS are excluded from the verdict to keep ` +
      "low-size noise out. Sessions whose total JS bundle size grew are listed below.",
    "",
  ];

  if (verdict !== "pass") {
    lines.push(
      `_${countSessionsWithoutIssue(comparisons)} compared session(s) did not create an issue._`,
      "",
    );
  }

  const increased = comparisons.filter((comparison) => comparison.delta > 0);

  if (increased.length === 0) {
    lines.push("No session's total JS bundle size increased from its base.");
  } else {
    const sessions = selectSessionsForTable(increased);
    const labels = buildSessionDisplayLabels(sessions);
    appendIncreasedSessionsTable(lines, sessions, labels, testRunId);
  }

  if (unknownBundleCount > 0) {
    lines.push(
      "",
      `_${unknownBundleCount} bundle load(s) had an unknown size and were ` +
        "excluded from the totals._",
    );
  }

  return lines.join("\n");
};

/**
 * Alarming (warn/fail) sessions are always shown. Non-threshold sessions that
 * still grew are capped at {@link MAX_PASSED_SESSIONS_IN_TABLE} (largest growth
 * first), so a passing run still shows its biggest movers without listing every
 * session.
 */
const selectSessionsForTable = (
  increased: SessionComparison[],
): SessionComparison[] => {
  const alarming = increased.filter(isAlarming);
  const passedIncreased = increased.filter(
    (comparison) => !isAlarming(comparison),
  );
  return [...alarming, ...passedIncreased.slice(0, MAX_PASSED_SESSIONS_IN_TABLE)];
};

/** One compact row per session whose total JS bundle size grew: totals, delta and %. */
const appendIncreasedSessionsTable = (
  lines: string[],
  sessions: SessionComparison[],
  labels: ReadonlyMap<string, string>,
  testRunId: string,
): void => {
  lines.push(
    "## Sessions with larger JS bundles",
    "",
    "| Session | Base | Head | Δ | % |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const comparison of sessions) {
    const label = labels.get(comparison.sessionId) ?? comparison.sessionId;
    const link = formatSessionLink(testRunId, comparison.sessionId, label);
    const tag = statusTag(comparison);
    const session = tag === "" ? link : `${tag} ${link}`;
    lines.push(
      `| ${session} | ${formatBytes(comparison.baseBytes)} | ${formatBytes(
        comparison.headBytes,
      )} | ${formatDelta(comparison.delta)} | ${formatPercent(
        comparison.percentIncrease,
      )} |`,
    );
  }
};

/**
 * Builds a `sessionId` -> display label map for sessions listed in report order.
 * Uses each session's `sessionDescription` when present (disambiguating
 * duplicates with a `(1)`, `(2)`, … suffix); otherwise falls back to `session1`,
 * `session2`, … by position.
 */
const buildSessionDisplayLabels = (
  sessionsInDisplayOrder: SessionComparison[],
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

// Links to a session within this test run, so the reader lands on the session's
// view in the context of the run whose bundles grew.
const sessionUrl = (testRunId: string, sessionId: string): string =>
  `${PROJECT_URL}/test-runs/${testRunId}/sessions/${sessionId}`;

/** Emoji flag for a session's verdict contribution: fail, warn, or none. */
const statusTag = (comparison: SessionComparison): string => {
  if (isFailing(comparison)) {
    return "❌";
  }
  if (isWarning(comparison)) {
    return "⚠️";
  }
  return "";
};

const formatDelta = (deltaBytes: number): string =>
  `${deltaBytes >= 0 ? "+" : "-"}${formatBytes(Math.abs(deltaBytes))}`;

const formatPercent = (percent: number): string => {
  if (!Number.isFinite(percent)) {
    return "new";
  }
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
};

/** Formats a byte count as B / KB / MB (base 1024), matching bundle tooling. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KB`;
  }
  return `${(kib / 1024).toFixed(2)} MB`;
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
