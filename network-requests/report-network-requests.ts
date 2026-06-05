/**
 * Example custom check that compares meaningful network request counts per
 * session on the head replay against the base replay of a test run:
 *
 *   - warns (without requiring acknowledgement) when a session issued at least
 *     WARN_PERCENT_INCREASE_THRESHOLD% more requests than base
 *   - warns and requires reviewer acknowledgement when a session issued at least
 *     FAIL_PERCENT_INCREASE_THRESHOLD% more requests than base
 *
 * Low-traffic session pairs (neither side reaching MIN_REQUESTS_FOR_ALARM) are
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

const NETWORK_REQUESTS_SNAPSHOT_TYPE = "network-requests";

/** Stable id of this check, shown in the Meticulous UI. */
const CHECK_ID = "network-requests";

/** Warn when a session's head request count exceeds base by at least this %. */
const WARN_PERCENT_INCREASE_THRESHOLD = 10;

/**
 * Warn and require reviewer acknowledgement when a session's head request count
 * exceeds base by at least this %.
 */
const FAIL_PERCENT_INCREASE_THRESHOLD = 20;

/**
 * Don't warn or fail on session pairs where neither side issued at least this
 * many meaningful requests — at very low counts a +1/+2 delta is noise and the
 * percentage swings are misleading (1 -> 2 = +100%).
 */
const MIN_REQUESTS_FOR_ALARM = 3;

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
        "Edit report-network-requests.ts and set PROJECT_URL to your Meticulous " +
        "project URL (e.g. https://app.meticulous.ai/projects/acme/web) before running.",
    );
  }
};

/** Hostname substrings to exclude from the comparison. */
const IGNORED_REQUEST_HOST_SUBSTRINGS = [
  "sentry.io",
  "segment.io",
  "google-analytics.com",
  "googletagmanager.com",
  // Add the third-party hosts your app loads during replay.
];

interface NetworkRequestData {
  url?: string;
  method?: string;
  requestBody?: string;
}

interface EndpointComparison {
  label: string;
  baseCount: number;
  headCount: number;
  delta: number;
}

interface SessionComparison {
  sessionId: string;
  /**
   * Human-readable summary of what the user did in the session (e.g. "Added an
   * item to the cart"), used to label the session in the report. `null` when
   * the session has no description, in which case we fall back to `session N`.
   */
  sessionDescription: string | null;
  baseCount: number;
  headCount: number;
  delta: number;
  percentIncrease: number;
  endpoints: EndpointComparison[];
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
    appInfo: "custom-checks-example/network-requests",
  });

  const { testRun } = await resolveTestRun(client, args);

  let result: ReportedCustomCheckResult;
  try {
    result = await computeNetworkRequestsCheck(client, testRun.id);
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
    .scriptName("report-network-requests")
    .usage(
      "$0 [testRunId] [options]\n\nReports the network-requests custom check for a test run.",
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

const computeNetworkRequestsCheck = async (
  client: MeticulousClient,
  testRunId: string,
): Promise<ReportedCustomCheckResult> => {
  const { baseSnapshots, headSnapshots } = await getSnapshotsFromTestRun({
    client,
    testRunId,
    snapshotTypes: [NETWORK_REQUESTS_SNAPSHOT_TYPE],
  });

  const comparisons = compareSessions(baseSnapshots, headSnapshots);
  const verdict = computeVerdict(comparisons);

  return {
    checkId: CHECK_ID,
    verdict,
    summary: summarize(verdict, comparisons),
    report: {
      type: "markdown",
      markdown: buildReport(verdict, comparisons, testRunId),
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

const networkRequestData = (snapshot: Snapshot): NetworkRequestData =>
  (snapshot.data ?? {}) as NetworkRequestData;

const isMeaningfulRequest = (snapshot: Snapshot): boolean => {
  const { url } = networkRequestData(snapshot);
  if (!url) {
    return true;
  }
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return !IGNORED_REQUEST_HOST_SUBSTRINGS.some((needle) =>
      hostname.includes(needle),
    );
  } catch {
    // Relative URLs (e.g. "/api/graphql") are same-origin app traffic.
    return true;
  }
};

/**
 * Produces a stable, human-readable label for a captured request so requests
 * can be grouped per endpoint/operation in the report:
 *
 *   - GraphQL requests (to a `/graphql` endpoint) are grouped by their
 *     operation name, e.g. `GetUser (GraphQL)`, since they all share one URL.
 *   - Everything else is grouped as `METHOD /path`, with id-like path segments
 *     collapsed to `:id` so e.g. `/users/<id>` routes group together.
 *
 * Cross-origin requests keep their host (so different hosts don't collide);
 * same-origin/relative requests use just the path, which keeps labels stable
 * across ephemeral preview hosts.
 */
const describeRequest = (snapshot: Snapshot): string => {
  const { url, method, requestBody } = networkRequestData(snapshot);
  if (!url) {
    return "(unknown request)";
  }

  const { hostname, pathname, query, isRelative } = parseUrl(url);

  if (isGraphqlPath(pathname)) {
    return describeGraphqlRequest(requestBody, query);
  }

  const verb = (method ?? "GET").toUpperCase();
  const path = normalizePath(pathname);
  const includeHost = !isRelative && hostname !== "";
  const route = includeHost ? `${hostname}${path}` : path;
  return `${verb} ${route}`;
};

interface ParsedUrl {
  hostname: string;
  pathname: string;
  query: URLSearchParams;
  isRelative: boolean;
}

const parseUrl = (url: string): ParsedUrl => {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      isRelative: false,
    };
  } catch {
    // Relative URL (e.g. "/api/graphql?op=..."): split path from query manually.
    const [path = "", queryString = ""] = url.split("?", 2);
    return {
      hostname: "",
      pathname: path,
      query: new URLSearchParams(queryString),
      isRelative: true,
    };
  }
};

const isGraphqlPath = (pathname: string): boolean =>
  pathname.toLowerCase().endsWith("/graphql");

const describeGraphqlRequest = (
  requestBody: string | undefined,
  query: URLSearchParams,
): string => {
  const operations = graphqlOperationNames(requestBody);
  // GET-style GraphQL passes the operation name in the query string instead.
  const queryOperation = query.get("operationName");
  if (operations.length === 0 && queryOperation) {
    operations.push(queryOperation);
  }

  if (operations.length === 0) {
    return "GraphQL (anonymous)";
  }
  if (operations.length === 1) {
    return `${operations[0]} (GraphQL)`;
  }
  return `GraphQL batch: ${operations.join(", ")}`;
};

// Matches `"operationName":"Foo"` even in a truncated body. Apollo serialises
// operationName before the (large) query, so it survives body truncation.
const GRAPHQL_OPERATION_NAME_RE = /"operationName"\s*:\s*"([^"]+)"/g;

const graphqlOperationNames = (body: string | undefined): string[] => {
  if (!body) {
    return [];
  }
  const names = new Set<string>();
  for (const match of body.matchAll(GRAPHQL_OPERATION_NAME_RE)) {
    names.add(match[1]);
  }
  return [...names];
};

// Path segments that look like an id (all digits, a uuid, or a long opaque
// token) are collapsed so dynamic routes group together.
const ID_SEGMENT_RE =
  /^(?:\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-zA-Z_-]{16,})$/;

const normalizePath = (pathname: string): string => {
  const normalized = pathname
    .split("/")
    .map((segment) =>
      segment && ID_SEGMENT_RE.test(segment) ? ":id" : segment,
    )
    .join("/");
  return normalized === "" ? "/" : normalized;
};

type RequestCountsByEndpoint = Map<string, number>;

const countRequestsBySession = (
  snapshots: Snapshot[],
): Map<string, RequestCountsByEndpoint> => {
  const countsBySession = new Map<string, RequestCountsByEndpoint>();
  for (const snapshot of snapshots) {
    if (snapshot.type !== NETWORK_REQUESTS_SNAPSHOT_TYPE) {
      continue;
    }
    if (!isMeaningfulRequest(snapshot)) {
      continue;
    }

    let byEndpoint = countsBySession.get(snapshot.sessionId);
    if (!byEndpoint) {
      byEndpoint = new Map();
      countsBySession.set(snapshot.sessionId, byEndpoint);
    }
    const label = describeRequest(snapshot);
    byEndpoint.set(label, (byEndpoint.get(label) ?? 0) + 1);
  }
  return countsBySession;
};

const sumCounts = (counts: RequestCountsByEndpoint): number => {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
};

/** Compares per-endpoint counts within a session, sorted by delta descending. */
const compareEndpoints = (
  baseByEndpoint: RequestCountsByEndpoint,
  headByEndpoint: RequestCountsByEndpoint,
): EndpointComparison[] => {
  const labels = new Set([...baseByEndpoint.keys(), ...headByEndpoint.keys()]);
  const endpoints: EndpointComparison[] = [];
  for (const label of labels) {
    const baseCount = baseByEndpoint.get(label) ?? 0;
    const headCount = headByEndpoint.get(label) ?? 0;
    endpoints.push({
      label,
      baseCount,
      headCount,
      delta: headCount - baseCount,
    });
  }
  return endpoints.sort(
    (a, b) => b.delta - a.delta || a.label.localeCompare(b.label),
  );
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

/** Session ids that have at least one network-requests snapshot (before filtering). */
const collectSessionIdsWithNetworkSnapshots = (
  snapshots: Snapshot[],
): Set<string> => {
  const sessionIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (snapshot.type === NETWORK_REQUESTS_SNAPSHOT_TYPE) {
      sessionIds.add(snapshot.sessionId);
    }
  }
  return sessionIds;
};

/**
 * Counts the *meaningful* network requests each session issued on base and
 * head, aligned by `sessionId`. Every session present in *either* replay is
 * compared, but sessions that ran only on head (no base replay) are omitted —
 * they cannot regress against a non-existent baseline.
 */
const compareSessions = (
  baseSnapshots: Snapshot[],
  headSnapshots: Snapshot[],
): SessionComparison[] => {
  const baseSessionIds = collectSessionIdsWithNetworkSnapshots(baseSnapshots);
  const baseCounts = countRequestsBySession(baseSnapshots);
  const headCounts = countRequestsBySession(headSnapshots);
  const sessionDescriptions = collectSessionDescriptionsById([
    ...baseSnapshots,
    ...headSnapshots,
  ]);

  const sessionIds = new Set([...baseCounts.keys(), ...headCounts.keys()]);
  const comparisons: SessionComparison[] = [];
  for (const sessionId of sessionIds) {
    if (!baseSessionIds.has(sessionId)) {
      continue;
    }
    const baseByEndpoint = baseCounts.get(sessionId) ?? new Map();
    const headByEndpoint = headCounts.get(sessionId) ?? new Map();
    const baseCount = sumCounts(baseByEndpoint);
    const headCount = sumCounts(headByEndpoint);
    comparisons.push({
      sessionId,
      sessionDescription: sessionDescriptions.get(sessionId) ?? null,
      baseCount,
      headCount,
      delta: headCount - baseCount,
      percentIncrease:
        baseCount === 0
          ? headCount > 0
            ? Infinity
            : 0
          : ((headCount - baseCount) / baseCount) * 100,
      endpoints: compareEndpoints(baseByEndpoint, headByEndpoint),
    });
  }
  // Surface the session whose number of network requests grew the most first
  // (delta descending). Ties break on the percentage increase, then sessionId
  // for a stable order.
  return comparisons.sort(
    (a, b) =>
      b.delta - a.delta ||
      b.percentIncrease - a.percentIncrease ||
      a.sessionId.localeCompare(b.sessionId),
  );
};

// Suppress both warn and fail on session pairs where neither side reached the
// minimum traffic floor: at <MIN_REQUESTS_FOR_ALARM requests, +1/+2 deltas are
// noise and percentage swings are misleading (1 -> 2 = +100%).
const hasEnoughTraffic = (comparison: SessionComparison): boolean =>
  Math.max(comparison.baseCount, comparison.headCount) >=
  MIN_REQUESTS_FOR_ALARM;

// Integer comparison of headCount/baseCount >= 1 + threshold/100, so an exact
// threshold increase (e.g. 100 -> 120 at 20%) fails instead of being lost to
// floating-point error. A session with no requests on base has no meaningful
// baseline to fail against, so it is excluded here.
const isFailing = (comparison: SessionComparison): boolean =>
  hasEnoughTraffic(comparison) &&
  comparison.baseCount > 0 &&
  comparison.headCount * 100 >=
    comparison.baseCount * (100 + FAIL_PERCENT_INCREASE_THRESHOLD);

// Sessions that ran on base but only issued telemetry (baseCount === 0) can
// still warn on a meaningful head increase as long as the head side cleared the
// traffic floor. Same integer arithmetic as `isFailing` so the boundary is exact.
const isWarning = (comparison: SessionComparison): boolean => {
  if (!hasEnoughTraffic(comparison) || comparison.delta <= 0) {
    return false;
  }
  if (isFailing(comparison)) {
    return false;
  }
  if (comparison.baseCount === 0) {
    return true;
  }
  return (
    comparison.headCount * 100 >=
    comparison.baseCount * (100 + WARN_PERCENT_INCREASE_THRESHOLD)
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
      return `${count} session(s) with ${FAIL_PERCENT_INCREASE_THRESHOLD}%+ more network requests${withoutIssueSuffix}`;
    }
    case "warn-without-requiring-user-ack": {
      const warnings = comparisons.filter(isWarning);
      const newTrafficWarningCount = warnings.filter(
        (comparison) => comparison.baseCount === 0,
      ).length;
      if (newTrafficWarningCount === warnings.length) {
        return `${warnings.length} session(s) with new meaningful network requests${withoutIssueSuffix}`;
      }
      if (newTrafficWarningCount === 0) {
        return `${warnings.length} session(s) with ${WARN_PERCENT_INCREASE_THRESHOLD}%+ more network requests${withoutIssueSuffix}`;
      }
      return `${warnings.length} session(s) with ${WARN_PERCENT_INCREASE_THRESHOLD}%+ more or new meaningful network requests${withoutIssueSuffix}`;
    }
    case "pass":
      return "No sessions issued meaningfully more network requests";
  }
};

/**
 * Builds a `sessionId` -> display label map for sessions listed in report
 * order. Uses each session's `sessionDescription` when present (disambiguating
 * duplicates with a `(1)`, `(2)`, … suffix); otherwise falls back to
 * `session1`, `session2`, … by position.
 */
const buildSessionDisplayLabels = (
  sessionsInDisplayOrder: SessionComparison[],
): Map<string, string> => {
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

const escapeMarkdownLinkLabel = (label: string): string =>
  label.replaceAll("[", "\\[").replaceAll("]", "\\]");

// Links to a session within this test run, so the reader lands on the session's
// view in the context of the run that issued the extra requests.
const sessionUrl = (testRunId: string, sessionId: string): string =>
  `${PROJECT_URL}/test-runs/${testRunId}/sessions/${sessionId}`;

/**
 * Renders the markdown report shown in the Meticulous UI: a short explanation
 * and (for each session whose request count increased on head) a
 * per-endpoint/operation breakdown of which requests grew, linked to that
 * session's view within the test run.
 */
const buildReport = (
  verdict: CustomCheckVerdict,
  comparisons: SessionComparison[],
  testRunId: string,
): string => {
  const lines: string[] = [
    "# Network requests",
    "",
    "This check counts the network requests each session made on this test run " +
      "and compares it against the base, ignoring third-party/telemetry traffic " +
      "(analytics, error tracking, fonts, etc.) so only the app's own requests " +
      `count. It warns when a session made at least ${WARN_PERCENT_INCREASE_THRESHOLD}% more requests ` +
      `than the base, or when a session with no meaningful base requests made enough new head requests to clear the traffic floor. ` +
      `It requires acknowledgement when a session with base requests made at least ${FAIL_PERCENT_INCREASE_THRESHOLD}% more. ` +
      `Session pairs where neither side issued ${MIN_REQUESTS_FOR_ALARM} or more requests are excluded ` +
      "to keep low-traffic noise out of the verdict. " +
      "Each session is broken down by endpoint, and GraphQL calls by operation " +
      "name, so you can see exactly which requests grew.",
    "",
  ];

  if (verdict !== "pass") {
    lines.push(
      `_${countSessionsWithoutIssue(comparisons)} compared session(s) did not create an issue._`,
      "",
    );
  }

  // Only list sessions that actually contributed to the verdict (warn or fail).
  const alarming = comparisons.filter(isAlarming);

  if (alarming.length === 0) {
    lines.push(
      `No session with a base replay made ${WARN_PERCENT_INCREASE_THRESHOLD}% or more extra network requests or introduced new meaningful app traffic.`,
    );
    return lines.join("\n");
  }

  const labels = buildSessionDisplayLabels(alarming);
  alarming.forEach((comparison) => {
    const label = labels.get(comparison.sessionId) ?? comparison.sessionId;
    const heading = `[${escapeMarkdownLinkLabel(label)}](${sessionUrl(testRunId, comparison.sessionId)})`;
    const tag = isFailing(comparison) ? "❌" : "⚠️";
    lines.push(
      "",
      `## ${heading} — ${comparison.baseCount} → ${comparison.headCount} requests ` +
        `(${formatDelta(comparison.delta)}, ${formatPercent(comparison.percentIncrease)}) ${tag}`,
      "",
      "| Endpoint / operation | Base | Head | Δ |",
      "| --- | ---: | ---: | ---: |",
    );
    // Only the endpoints/operations that grew explain the increase.
    const grownEndpoints = comparison.endpoints.filter(
      (endpoint) => endpoint.delta > 0,
    );
    for (const endpoint of grownEndpoints) {
      lines.push(
        `| ${endpoint.label} | ${endpoint.baseCount} | ${endpoint.headCount} | ${formatDelta(endpoint.delta)} |`,
      );
    }
  });

  return lines.join("\n");
};

const formatDelta = (delta: number): string =>
  delta > 0 ? `+${delta}` : `${delta}`;

const formatPercent = (percent: number): string => {
  if (!Number.isFinite(percent)) {
    // A session with no requests on base has no finite percentage increase.
    return "new";
  }
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
