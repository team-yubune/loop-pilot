import { ghApi } from "./gh.js";
import { botLoginMatchesGraphql } from "./bot-login.js";
import { parseGraphqlCommentId } from "./graphql-comment-id.js";
import { parseSeverity, isAtLeastSeverity } from "./severity-parser.js";
import type { Finding, Severity } from "./types.js";

/**
 * GraphQL query for one page of review threads enriched with the first
 * comment's author, body, path, and line — the fields
 * `fetchUnresolvedCodexFindings` needs to construct a `Finding[]`. The
 * existing `review-thread-resolver.ts` query only fetches `databaseId` (it
 * resolves by id, not content), so a separate query is necessary.
 */
const UNRESOLVED_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id
          isResolved
          isOutdated
          path
          line
          comments(first:1){
            nodes{databaseId fullDatabaseId author{login} body createdAt}
          }
        }
      }
    }
  }
}`;

const MAX_PAGES = 50;

/**
 * Thrown when the unresolved-thread GraphQL query fails transiently or returns
 * an unusable shape. ES-413 (Codex P2): `/restart-review` must fail closed on
 * this instead of treating it as "zero unresolved findings" — otherwise a
 * transient fetch error would route a recovery restart into Case B (post a
 * fresh `@codex review`) and silently skip the intended Case A repair, leaving
 * the PR wedged behind the same unresolved threads. Surfacing it as an error
 * makes the run retryable (re-issue `/restart-review` once the API recovers).
 */
export class UnresolvedFindingsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedFindingsFetchError";
  }
}

export interface FetchUnresolvedCodexFindingsParams {
  owner: string;
  repo: string;
  prNumber: number;
  codexBotLogin: string;
  severityThreshold: Severity;
  token: string;
}

export interface FetchUnresolvedCodexFindingsDeps {
  warning: (message: string) => void;
}

interface RawThreadNode {
  id?: unknown;
  isResolved?: unknown;
  isOutdated?: unknown;
  path?: unknown;
  line?: unknown;
  comments?: {
    nodes?: Array<{
      databaseId?: unknown;
      fullDatabaseId?: unknown;
      author?: { login?: unknown };
      body?: unknown;
      createdAt?: unknown;
    }>;
  };
}

interface ParsedPage {
  findings: Finding[];
  hasNextPage: boolean;
  endCursor: string | null;
  malformed: boolean;
  skippedNonCodex: number;
  skippedResolved: number;
  skippedOutdated: number;
  latestOutdatedAt: string | null;
  skippedUnparseable: number;
  skippedBelowThreshold: number;
  skippedMalformedId: number;
  skippedMalformedNode: number;
}

function parsePage(
  stdout: string,
  codexBotLogin: string,
  severityThreshold: Severity,
): ParsedPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      findings: [],
      hasNextPage: false,
      endCursor: null,
      malformed: true,
      skippedNonCodex: 0,
      skippedResolved: 0,
      skippedOutdated: 0,
      latestOutdatedAt: null,
      skippedUnparseable: 0,
      skippedBelowThreshold: 0,
      skippedMalformedId: 0,
      skippedMalformedNode: 0,
    };
  }
  const typed = parsed as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
            nodes?: unknown[];
          };
        };
      };
    };
  };
  const threads = typed.data?.repository?.pullRequest?.reviewThreads;
  if (threads === undefined || threads === null) {
    return {
      findings: [],
      hasNextPage: false,
      endCursor: null,
      malformed: true,
      skippedNonCodex: 0,
      skippedResolved: 0,
      skippedOutdated: 0,
      latestOutdatedAt: null,
      skippedUnparseable: 0,
      skippedBelowThreshold: 0,
      skippedMalformedId: 0,
      skippedMalformedNode: 0,
    };
  }

  const rawNodes = Array.isArray(threads.nodes) ? threads.nodes : [];
  const findings: Finding[] = [];
  let skippedNonCodex = 0;
  let skippedResolved = 0;
  let skippedOutdated = 0;
  let latestOutdatedAt: string | null = null;
  let skippedUnparseable = 0;
  let skippedBelowThreshold = 0;
  let skippedMalformedId = 0;
  let skippedMalformedNode = 0;

  for (const raw of rawNodes) {
    // ES-413 (Codex P2): GitHub's GraphQL `reviewThreads.nodes` can contain a
    // `null` entry (e.g. a thread the viewer cannot see). Reading `.isResolved`
    // off `null` would throw outside the `ghApi` try/catch and crash the whole
    // `/restart-review` instead of skipping one malformed thread, so guard the
    // node shape before touching any property.
    if (raw === null || typeof raw !== "object") {
      skippedMalformedNode += 1;
      continue;
    }
    const node = raw as RawThreadNode;
    if (node.isResolved === true) {
      skippedResolved += 1;
      continue;
    }
    const firstComment = Array.isArray(node.comments?.nodes)
      ? node.comments!.nodes[0]
      : undefined;
    if (!firstComment) continue;
    // GraphQL `author.login` omits the `[bot]` suffix that the REST API
    // includes (e.g. "chatgpt-codex-connector" vs "chatgpt-codex-connector[bot]").
    // `botLoginMatchesGraphql` matches the base name (GraphQL `author.login`
    // has no `[bot]` suffix for Apps) regardless of which form `codexBotLogin`
    // uses (ES-426 #1). REST call sites use the suffix-anchored `botLoginMatches`.
    const authorLogin = typeof firstComment.author?.login === "string"
      ? firstComment.author.login
      : "";
    if (!botLoginMatchesGraphql(authorLogin, codexBotLogin)) {
      skippedNonCodex += 1;
      continue;
    }

    if (node.isOutdated === true) {
      skippedOutdated += 1;
      if (typeof firstComment.createdAt === "string") {
        if (latestOutdatedAt === null || firstComment.createdAt > latestOutdatedAt) {
          latestOutdatedAt = firstComment.createdAt;
        }
      }
      continue;
    }

    const body = typeof firstComment.body === "string" ? firstComment.body : "";
    const result = parseSeverity(body);
    if (result.severity === null) {
      skippedUnparseable += 1;
      continue;
    }
    if (!isAtLeastSeverity(result.severity, severityThreshold)) {
      skippedBelowThreshold += 1;
      continue;
    }

    // Prefer the 64-bit-safe `fullDatabaseId`; fall back to the deprecated
    // `databaseId` for older comments / API responses that still populate it.
    const commentId =
      parseGraphqlCommentId(firstComment.fullDatabaseId) ??
      parseGraphqlCommentId(firstComment.databaseId);
    if (commentId === null) {
      skippedMalformedId += 1;
      continue;
    }

    findings.push({
      severity: result.severity,
      commentId,
      path: typeof node.path === "string" ? node.path : "",
      line: typeof node.line === "number" ? node.line : null,
      title: result.title,
      body: result.body,
      createdAt:
        typeof firstComment.createdAt === "string"
          ? firstComment.createdAt
          : undefined,
    });
  }

  return {
    findings,
    hasNextPage: threads.pageInfo?.hasNextPage === true,
    endCursor:
      typeof threads.pageInfo?.endCursor === "string"
        ? threads.pageInfo.endCursor
        : null,
    malformed: false,
    skippedNonCodex,
    skippedResolved,
    skippedOutdated,
    latestOutdatedAt,
    skippedUnparseable,
    skippedBelowThreshold,
    skippedMalformedId,
    skippedMalformedNode,
  };
}

/**
 * Fetch all unresolved Codex review threads on a PR and return them as
 * `Finding[]`. Filters by `!isResolved`, Codex bot authorship, and the
 * severity threshold. Pagination follows the same strategy as
 * `review-thread-resolver.ts` (100 threads/page, max 50 pages).
 */
export interface FetchUnresolvedCodexFindingsResult {
  findings: Finding[];
  latestOutdatedAt: string | null;
}

export async function fetchUnresolvedCodexFindings(
  params: FetchUnresolvedCodexFindingsParams,
  deps: FetchUnresolvedCodexFindingsDeps = { warning: () => {} },
): Promise<FetchUnresolvedCodexFindingsResult> {
  const all: Finding[] = [];
  let cursor: string | null = null;
  let totalSkippedOutdated = 0;
  let overallLatestOutdatedAt: string | null = null;
  let totalSkippedUnparseable = 0;
  let totalSkippedBelowThreshold = 0;
  let totalSkippedMalformedId = 0;
  let totalSkippedMalformedNode = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-f",
      `owner=${params.owner}`,
      "-f",
      `name=${params.repo}`,
      "-F",
      `number=${params.prNumber}`,
    ];
    if (cursor !== null) {
      args.push("-f", `cursor=${cursor}`);
    }
    let stdout: string;
    try {
      stdout = await ghApi(args, params.token);
    } catch (error) {
      // ES-413 (Codex P2): fail closed — do NOT return [] (which the caller
      // would treat as "no unresolved findings" and route to a fresh @codex
      // review, skipping the Case A repair).
      throw new UnresolvedFindingsFetchError(
        `[unresolved-findings] Could not fetch review threads for ` +
          `${params.owner}/${params.repo}#${params.prNumber}: ${
            error instanceof Error ? error.message : String(error)
          }. Aborting /restart-review so unresolved Codex findings are not skipped; re-run once the API recovers.`,
      );
    }
    const pageResult = parsePage(
      stdout,
      params.codexBotLogin,
      params.severityThreshold,
    );

    if (pageResult.malformed) {
      // ES-413 (Codex P2): same fail-closed rationale as the fetch error above.
      throw new UnresolvedFindingsFetchError(
        `[unresolved-findings] GraphQL response for ` +
          `${params.owner}/${params.repo}#${params.prNumber} (page ${page}) ` +
          `is missing the reviewThreads container or is not valid JSON; ` +
          `the token may lack access or the API shape changed. Aborting ` +
          `/restart-review so unresolved Codex findings are not skipped.`,
      );
    }

    all.push(...pageResult.findings);
    totalSkippedOutdated += pageResult.skippedOutdated;
    if (pageResult.latestOutdatedAt !== null &&
        (overallLatestOutdatedAt === null || pageResult.latestOutdatedAt > overallLatestOutdatedAt)) {
      overallLatestOutdatedAt = pageResult.latestOutdatedAt;
    }
    totalSkippedUnparseable += pageResult.skippedUnparseable;
    totalSkippedBelowThreshold += pageResult.skippedBelowThreshold;
    totalSkippedMalformedId += pageResult.skippedMalformedId;
    totalSkippedMalformedNode += pageResult.skippedMalformedNode;

    if (!pageResult.hasNextPage || pageResult.endCursor === null) break;
    cursor = pageResult.endCursor;

    if (page === MAX_PAGES - 1) {
      deps.warning(
        `[unresolved-findings] Hit MAX_PAGES (${MAX_PAGES}) for ` +
          `${params.owner}/${params.repo}#${params.prNumber} with more pages remaining; ` +
          `the unresolved findings set may be incomplete.`,
      );
    }
  }

  if (totalSkippedOutdated > 0) {
    deps.warning(
      `[unresolved-findings] Skipped ${totalSkippedOutdated} outdated Codex thread(s) ` +
        `(code already changed since finding was posted).`,
    );
  }
  if (totalSkippedUnparseable > 0) {
    deps.warning(
      `[unresolved-findings] Skipped ${totalSkippedUnparseable} unresolved Codex thread(s) ` +
        `with unparseable severity.`,
    );
  }
  if (totalSkippedBelowThreshold > 0) {
    deps.warning(
      `[unresolved-findings] Skipped ${totalSkippedBelowThreshold} unresolved Codex thread(s) ` +
        `below severity threshold (${params.severityThreshold}).`,
    );
  }
  if (totalSkippedMalformedId > 0) {
    deps.warning(
      `[unresolved-findings] Dropped ${totalSkippedMalformedId} unresolved Codex thread(s) ` +
        `with no usable databaseId/fullDatabaseId; the GraphQL comment schema may have changed.`,
    );
  }
  if (totalSkippedMalformedNode > 0) {
    deps.warning(
      `[unresolved-findings] Dropped ${totalSkippedMalformedNode} null/malformed ` +
        `reviewThreads node(s); GitHub returned entries the token cannot resolve.`,
    );
  }

  return { findings: all, latestOutdatedAt: overallLatestOutdatedAt };
}
