import * as core from "@actions/core";
import { isAtLeastSeverity, parseSeverity } from "./severity-parser.js";
import { botLoginMatches } from "./bot-login.js";
import { ghApi } from "./gh.js";
import type {
  FetchReviewCommentsFn,
  Finding,
  RawReviewComment,
  Severity,
  SleepFn,
} from "./types.js";

/**
 * `filterAndParseComments` の戻り値。`skipped` は observability 用のカウンタで、
 * Codex finding を `unparseable` (severity 不明) と `belowThreshold` (threshold 未達) に
 * 区別して提供する。両者は pre-fix 側でログレベルを使い分けるため別カウンタになっている。
 */
export interface FilteredComments {
  findings: Finding[];
  skipped: {
    unparseable: number;
    belowThreshold: number;
    threadReplies: number;
  };
}

export interface StabilizeReviewCommentsOptions {
  botLogin: string;
  lastReceivedAt: string | null;
  triggerSummaryBody: string;
  severityThreshold: Severity;
  intervalMs: number;
  stablePolls: number;
  maxWaitMs: number;
  fetchComments: FetchReviewCommentsFn;
  sleep: SleepFn;
  log?: (message: string) => void;
  // When true, run stabilization polling even if summaryMayContainFindings
  // returns false — used when the debounce was skipped so that a false
  // negative in the no-findings heuristic still gets a re-poll safety net.
  forceStabilize?: boolean;
}

/**
 * Fetches PR inline review comments from GitHub API using the gh CLI.
 *
 * Why NDJSON via --jq: gh's --paginate flag accumulates pages into a single
 * JSON array by default, which can exhaust memory for large PRs. Streaming
 * one object per line (NDJSON) via .[] | {...} keeps memory usage constant.
 */
export async function fetchReviewComments(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  githubToken: string
): Promise<RawReviewComment[]> {
  const stdout = await ghApi(
    [
      "api",
      `repos/${repoOwner}/${repoName}/pulls/${prNumber}/comments`,
      "--paginate",
      "--jq",
      // @json ensures each result is a single-line JSON-encoded string,
      // preventing multi-line jq pretty-printing from breaking split("\n") parsing
      ".[] | {id: .id, user: {login: .user.login}, body: .body, path: .path, line: .line, createdAt: .created_at, inReplyToId: .in_reply_to_id} | @json",
    ],
    githubToken,
  );

  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      const parsed = parseReviewCommentRecord(line);
      if (!parsed) {
        core.warning(`[review-collector] Skipping unparseable comment line: ${line.slice(0, 120)}`);
        return [];
      }
      return [parsed];
    });
}

export function parseReviewCommentRecord(line: string): RawReviewComment | null {
  function isRecord(value: unknown): value is RawReviewComment {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    const user = record.user as Record<string, unknown> | null;
    if (!(
      typeof record.id === "number" &&
      typeof user === "object" &&
      user !== null &&
      typeof user.login === "string" &&
      typeof record.body === "string" &&
      typeof record.path === "string" &&
      (typeof record.line === "number" || record.line === null) &&
      typeof record.createdAt === "string"
    )) return false;
    if (record.inReplyToId === undefined) {
      record.inReplyToId = null;
    }
    return typeof record.inReplyToId === "number" || record.inReplyToId === null;
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
    if (typeof parsed === "string") {
      const nested = JSON.parse(parsed) as unknown;
      if (isRecord(nested)) {
        return nested;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Filters raw review comments by bot login and timestamp, parses severity,
 * and returns findings whose severity is at least the given threshold.
 *
 * Why strict greater-than for timestamp: a comment received exactly at
 * lastReceivedAt was already processed in the previous iteration.
 *
 * Observability (TY-256): skipped comments are reported via the `skipped`
 * counter, split into `unparseable` (severity could not be parsed) and
 * `belowThreshold` (parsed severity is less urgent than the threshold).
 * Callers use the breakdown to log warnings vs informational messages.
 */
export function filterAndParseComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  threshold: Severity,
): FilteredComments {
  const findings: Finding[] = [];
  let unparseable = 0;
  let belowThreshold = 0;
  let threadReplies = 0;

  for (const comment of comments) {
    if (!botLoginMatches(comment.user.login, botLogin)) continue;
    if (lastReceivedAt !== null && !(comment.createdAt > lastReceivedAt)) continue;
    if (comment.inReplyToId != null) {
      threadReplies += 1;
      continue;
    }

    const parsed = parseSeverity(comment.body);
    if (parsed.severity === null) {
      unparseable += 1;
      continue;
    }
    if (!isAtLeastSeverity(parsed.severity, threshold)) {
      belowThreshold += 1;
      continue;
    }
    findings.push({
      severity: parsed.severity,
      // TY-360: carry the comment id (see `CommentId` in types.ts) so post-fix
      // can map this in-scope finding to its review thread and resolve it.
      commentId: comment.id,
      path: comment.path,
      // TY-280: preserve null so the prompt can format file-level / outdated
      // findings as `(file-level)` instead of `path:0` (which would imply a
      // real first-line anchor).
      line: comment.line,
      title: parsed.title,
      body: parsed.body,
    });
  }

  return {
    findings,
    skipped: { unparseable, belowThreshold, threadReplies },
  };
}

export function shouldStabilizeReviewComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  triggerSummaryBody: string,
  threshold: Severity
): boolean {
  return (
    countRelevantBotComments(comments, botLogin, lastReceivedAt, threshold) === 0 &&
    summaryMayContainFindings(triggerSummaryBody, threshold)
  );
}

export async function stabilizeReviewComments(
  initialComments: RawReviewComment[],
  options: StabilizeReviewCommentsOptions
): Promise<RawReviewComment[]> {
  const stablePolls = Math.max(1, options.stablePolls);
  const intervalMs = Math.max(1, options.intervalMs);
  const maxWaitMs = Math.max(intervalMs * stablePolls, options.maxWaitMs);

  // forceStabilize: when the caller skipped the upstream debounce based on a
  // "no findings" summary, this stabilization run is the only safety net for
  // late-arriving inline comments. Always enter the polling loop so a still-
  // arriving batch isn't truncated by a non-zero initial fetch (TY-294).
  const skip = options.forceStabilize
    ? false
    : !shouldStabilizeReviewComments(
        initialComments,
        options.botLogin,
        options.lastReceivedAt,
        options.triggerSummaryBody,
        options.severityThreshold
      );
  if (skip) {
    return initialComments;
  }

  let latestComments = initialComments;
  let lastCount = countRelevantBotComments(
    latestComments,
    options.botLogin,
    options.lastReceivedAt,
    options.severityThreshold
  );
  let stableCount = 0;
  let waitedMs = 0;

  options.log?.(
    `[review-collector] No Codex inline comments yet; waiting for count to stabilize (${stablePolls} polls).`
  );

  while (waitedMs < maxWaitMs) {
    await options.sleep(intervalMs);
    waitedMs += intervalMs;

    const nextComments = await options.fetchComments();
    const nextCount = countRelevantBotComments(
      nextComments,
      options.botLogin,
      options.lastReceivedAt,
      options.severityThreshold
    );

    if (nextCount === lastCount) {
      stableCount += 1;
    } else {
      options.log?.(
        `[review-collector] Codex inline comment count changed ${lastCount} -> ${nextCount}; resetting stabilization count.`
      );
      stableCount = 0;
      lastCount = nextCount;
    }

    latestComments = nextComments;

    if (stableCount >= stablePolls) {
      // TY-294: when forceStabilize is on and we still see zero comments,
      // keep polling for the full debounce window. The original (un-skipped)
      // flow waited debounceSeconds before its first fetch, so exiting after
      // only stablePolls * intervalMs (~30s with defaults) would conclude
      // "no comments" sooner than the pre-change behavior and could miss a
      // false-negative "no findings" summary whose inline comments arrive
      // late.
      const mustObserveFullWindow =
        options.forceStabilize === true && lastCount === 0;
      if (!mustObserveFullWindow) break;
    }
  }

  options.log?.(
    `[review-collector] Stabilization finished after ${waitedMs}ms with ${lastCount} Codex inline comment(s).`
  );
  return latestComments;
}

function countRelevantBotComments(
  comments: RawReviewComment[],
  botLogin: string,
  lastReceivedAt: string | null,
  threshold: Severity
): number {
  return comments.filter((comment) => {
    if (!botLoginMatches(comment.user.login, botLogin)) return false;
    if (lastReceivedAt !== null && !(comment.createdAt > lastReceivedAt)) return false;
    if (comment.inReplyToId != null) return false;
    const parsed = parseSeverity(comment.body);
    return parsed.severity !== null && isAtLeastSeverity(parsed.severity, threshold);
  }).length;
}

/**
 * Returns `false` when `body` clearly indicates no in-scope findings
 * (Codex no-issues summary), `true` otherwise.
 *
 * TY-294: exported so `main-pre-fix.ts` can short-circuit the initial 90s
 * debounce when Codex returned a "no findings" summary — `inline` comments
 * are guaranteed to be empty in that case, so the debounce buys nothing.
 * The same function still drives `shouldStabilizeReviewComments` for the
 * second-stage stabilization safeguard.
 */
export function summaryMayContainFindings(
  body: string,
  threshold: Severity,
): boolean {
  const normalized = body.toLowerCase();
  const noFindingsPatterns = [
    /\bno\s+findings?\b/i,
    /\b0\s+findings?\b/i,
    /\bno\s+issues?\b/i,
    // TY-294: non-"major" forms are unconditional no-findings signals.
    // Accept both ASCII (') and typographic (’) apostrophes so the
    // U+2019 variant Codex sometimes emits still matches.
    /\bdidn['’]?t\s+find\s+(?:any\s+)?(?:issues?|findings?)\b/i,
    /\bno\s+issues?\s+found\b/i,
    /指摘なし/,
    /問題なし/,
  ];
  if (noFindingsPatterns.some((pattern) => pattern.test(body))) {
    // An explicit in-scope severity label in the same text overrides the
    // no-findings phrase (e.g. "didn't find any issues ... 1 P1 finding").
    const inScopeSeveritySignal = (["P0", "P1", "P2", "P3"] as Severity[]).some(
      (s) =>
        isAtLeastSeverity(s, threshold) &&
        new RegExp(`\\b${s}\\b`, "i").test(body),
    );
    if (!inScopeSeveritySignal) {
      // Strip the matched no-findings clause(s) and check whether residual
      // language in the rest of the text suggests inline comments may still
      // arrive (e.g. "Didn't find any issues blocking merge, but I left
      // suggestions inline"). Without stripping, "issues" inside the matched
      // clause would always appear as a residual signal.
      let strippedNoFindings = body;
      for (const p of noFindingsPatterns) {
        strippedNoFindings = strippedNoFindings.replace(
          new RegExp(p.source, "gi"),
          "",
        );
      }
      const hasResidualFindingsSignal =
        /\bfindings?\b/i.test(strippedNoFindings) ||
        /\bissues?\b/i.test(strippedNoFindings) ||
        /\bsuggestions?\b/i.test(strippedNoFindings) ||
        /\bcomments?\b/i.test(strippedNoFindings) ||
        /指摘|問題|検出/.test(strippedNoFindings);
      if (!hasResidualFindingsSignal) {
        return false;
      }
      // Residual signal found — fall through to generic keyword check.
    }
    // Fall through to let the severity-aware logic below give the answer.
  }

  // "no major issues" patterns: Codex's standard no-findings reply. Treat as
  // terminal no-findings when no explicit in-scope severity signal appears in
  // the text (e.g. "Didn't find any major issues, but found 2 P3 findings"
  // must still return true when threshold is P3).
  // Accept both ASCII (') and typographic (’, U+2019) apostrophes — Codex
  // summaries sometimes get auto-typographed in transit (TY-294).
  const noMajorIssuesPatterns = [
    /\bdidn['’]?t\s+find\s+(?:any\s+)?major\s+(?:issues?|findings?)\b/i,
    /\bno\s+major\s+issues?\s+found\b/i,
  ];
  if (noMajorIssuesPatterns.some((p) => p.test(body))) {
    const inScopeSeveritySignal = (["P0", "P1", "P2", "P3"] as Severity[]).some(
      (s) =>
        isAtLeastSeverity(s, threshold) &&
        new RegExp(`\\b${s}\\b`, "i").test(body),
    );
    if (!inScopeSeveritySignal) {
      // No explicit severity label — strip the negated "no major" clause itself
      // and check whether residual findings/issues keywords indicate unlabeled
      // findings alongside the no-major-issues phrase (e.g. "Didn't find any
      // major issues, but found a few minor findings"). Without stripping, the
      // "issues" word in the matched clause would always appear as a residual.
      const stripped = body
        .replace(/\bdidn['’]?t\s+find\s+(?:any\s+)?major\s+(?:issues?|findings?)\b/gi, "")
        .replace(/\bno\s+major\s+issues?\s+found\b/gi, "");
      const hasResidualFindingsSignal =
        /\bfindings?\b/i.test(stripped) ||
        /\bissues?\b/i.test(stripped) ||
        /\bsuggestions?\b/i.test(stripped) ||
        /\bcomments?\b/i.test(stripped) ||
        /指摘|問題|検出/.test(stripped);
      // TY-294: "no major issues" is a terminal no-findings signal at any
      // threshold when no residual language hints at unlabeled findings or
      // inline comments. The default threshold is P3, so omitting the
      // threshold guard here is required for the debounce skip to take effect
      // in the default configuration.
      if (!hasResidualFindingsSignal) {
        return false;
      }
      // Residual signal found — fall through to generic keyword check.
    }
    // An in-scope severity signal is present — fall through so the severity
    // signal block below can return the authoritative answer.
  }

  // "No PX findings" requires threshold-aware handling: "No P3 findings" is not
  // a global no-findings signal when the threshold is P2 and the body also
  // mentions in-scope severities like P1/P2. Collect every negated severity
  // from all "No P… findings" clauses in the body, then only return false when
  // no un-negated in-scope severity also appears elsewhere in the text.
  const specificNoFindingsMatches = [
    ...body.matchAll(/\bno\s+(p[0-3](?:\s*\/\s*p[0-3])*)\s+findings?\b/gi),
  ];
  if (specificNoFindingsMatches.length > 0) {
    const negatedSeverities = new Set(
      specificNoFindingsMatches.flatMap((m) =>
        (m[1].match(/p[0-3]/gi) ?? []).map((s) => s.toUpperCase()),
      ),
    );
    const hasUnNegatedInScopeSignal = (["P0", "P1", "P2", "P3"] as Severity[])
      .filter((s) => isAtLeastSeverity(s, threshold) && !negatedSeverities.has(s))
      .some((s) => new RegExp(`\\b${s}\\b`, "i").test(body));
    if (!hasUnNegatedInScopeSignal) {
      return false;
    }
    // An un-negated in-scope severity appears in the body — fall through to the
    // severitySignal block so it can be detected as a positive signal.
  }

  // Only treat an explicit severity label as a positive signal if it is at or
  // above the threshold — a P3-only mention must not trigger stabilization
  // polling when the threshold is P2, because those findings will be filtered
  // out anyway (TY-256).
  const severitySignal =
    (isAtLeastSeverity("P0", threshold) && /\bp0\b/i.test(body)) ||
    (isAtLeastSeverity("P1", threshold) && /\bp1\b/i.test(body)) ||
    (isAtLeastSeverity("P2", threshold) && /\bp2\b/i.test(body)) ||
    (isAtLeastSeverity("P3", threshold) && /\bp3\b/i.test(body));

  // When the summary explicitly names a severity, the severity signal is the
  // authoritative answer — falling back to generic "findings"/"issues" words
  // when the named severity is below threshold would re-introduce the
  // unnecessary polling the threshold gate was meant to avoid (TY-256). The
  // generic-keyword fallback applies only when no severity is named, which
  // is the conservative case (e.g., Codex summary changes its format and
  // omits explicit severities — we still want to enter stabilization).
  const mentionsAnySeverity = /\bp[0-3]\b/i.test(body);
  if (mentionsAnySeverity) {
    return severitySignal;
  }

  return (
    /\bfindings?\b/.test(normalized) ||
    /\bissues?\b/.test(normalized) ||
    // Codex's standard review summary ("Here are some automated review
    // suggestions for this pull request.") names no severity and contains
    // neither "findings" nor "issues", so without "suggestions" here it
    // returned false — silently skipping the debounce on the primary
    // pull_request_review trigger even when inline findings exist. The
    // no-findings residual check above already treats "suggestions" as a
    // findings signal; mirror it in this generic fallback so the two agree.
    /\bsuggestions?\b/.test(normalized) ||
    /指摘|問題|検出/.test(body)
  );
}
