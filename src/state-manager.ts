import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import {
  PREVIOUS_CHECK_FAILURE_MAX_CHARS,
  truncatePreviousCheckFailure,
} from "./claude-code-repair-request.js";
import { STOP_REASON_LABELS, type ReviewState } from "./types.js";

/**
 * Safety-margin upper bound for `previousCheckFailure` length on the read
 * path (TY-275 #9). Writes go through `truncatePreviousCheckFailure` and
 * are capped at `PREVIOUS_CHECK_FAILURE_MAX_CHARS`; a hand-edited or legacy
 * state comment can carry more. We reject anything beyond 2× that cap so
 * downstream `serializeState` cannot blow through the GitHub comment-body
 * limit (65,536 chars) and we surface tampering instead of silently
 * accepting an oversized blob.
 */
const PREVIOUS_CHECK_FAILURE_READ_LIMIT = PREVIOUS_CHECK_FAILURE_MAX_CHARS * 2;

const STATE_MARKER = "looppilot-state";
const STATE_COMMENT_OPEN = "<!-- " + STATE_MARKER;
const STATE_COMMENT_CLOSE = "-->";
const STATE_COMMENT_VISIBLE_TEXT = "LoopPilot state is stored in this comment.";
// TY-296: keep the per-write history cap aligned with the default
// `MAX_REVIEW_ITERATIONS` (config.ts → 20) so `isLoop` can detect oscillations
// whose cycle length exceeds 3. With the old cap of 3, an A→B→C→D→A pattern
// trimmed the original A out of history before it could re-match and burned
// every iteration at the base tier until `max_iterations`. 1 entry is ~70
// bytes; 20 entries fit comfortably under MAX_SERIALIZED_BYTES (65,000) even
// alongside a full `previousCheckFailure` payload.
export const MAX_HISTORY_ENTRIES = 20;
const MAX_SERIALIZED_BYTES = 65000;
const VALID_STATUSES = new Set(["initialized", "waiting_codex", "fixing", "done", "stopped"]);
const VALID_STOP_REASONS = new Set<string>(Object.keys(STOP_REASON_LABELS));

// TY-339 #1: `serializeState`'s step-3 floor (drop `previousCheckFailure` to
// null) only really "guarantees the body fits" if every *other* string field
// is bounded too. `validateState` already caps `previousCheckFailure`
// (PREVIOUS_CHECK_FAILURE_READ_LIMIT) but left `lastClaudeCommitSha`,
// `lastFindingsHash`, and `findingsHashHistory[].hash` length-unbounded, so a
// hand-edited / tampered state could pass validation and still push the floor
// body past GitHub's 65,536-char comment-body limit. Cap them generously above
// any legitimate value: a git SHA is 40 hex (64 for SHA-256) and the findings
// hash is the 16-hex prefix produced by `computeFindingsHash`.
const LAST_CLAUDE_COMMIT_SHA_MAX_CHARS = 64;
const FINDINGS_HASH_MAX_CHARS = 64;

// TY-339 #1 follow-up: the `serializeState` step-3 floor keeps these two
// timestamp fields verbatim (it only nulls `previousCheckFailure` and trims
// history to one entry), so they must be length-bounded for the floor's
// "body fits under MAX_SERIALIZED_BYTES" guarantee to actually hold — the same
// reasoning that capped `lastClaudeCommitSha` / `lastFindingsHash` /
// `findingsHashHistory[].hash` above. The loop only ever writes short ISO-8601
// strings (~24 chars); 64 leaves generous headroom so every legitimate /
// legacy value passes and only a tampered oversized blob is rejected
// (→ `state_corrupted`, symmetric with the SHA / hash fields).
const TIMESTAMP_MAX_CHARS = 64;

// TY-360: `currentIterationFindingCommentIds` is a variable-length array, so it
// must be length-bounded for the "body fits under MAX_SERIALIZED_BYTES"
// guarantee to hold — same reasoning as the string-length caps above. In-scope
// findings per iteration are realistically a handful (Codex rarely emits dozens
// of inline comments and the repair prompt itself caps embedding at
// MAX_FINDINGS_PER_REQUEST = 30); a numeric comment id serializes to ~12 chars,
// so 500 ids (~6 KB) stays far under the floor. The bound is enforced on BOTH
// sides: `serializeState` clamps it on the write path (so an in-memory state is
// never persisted over-budget), and `validateState` rejects an over-cap array
// on the read path (a tampered / pathological state → `state_corrupted`,
// symmetric with the SHA / hash / timestamp fields).
const MAX_FINDING_COMMENT_IDS = 500;

// TY-272 #A: trust-boundary author filter for the hidden state comment.
//
// Public PRs let any commenter post a body that contains our hidden state
// marker. The body-only jq filter would happily pick the attacker's comment as
// the "latest" state (gh paginate is ascending, the last match wins) and an
// adversary could stuff `{"status":"done"}` to silently stop LoopPilot.
//
// State comments are always created by the workflow's `GITHUB_TOKEN` /
// `secrets.LOOPPILOT_PUSH_TOKEN`-equivalent identity, so the author is
// `github-actions[bot]` (or whatever bot the deployment runs as). Deployments
// using a GitHub App / machine user may add their own author via the env var
// below; the default still covers the standard `GITHUB_TOKEN` flow.
const DEFAULT_TRUSTED_STATE_AUTHOR = "github-actions[bot]";
const TRUSTED_STATE_AUTHORS_ENV = "LOOPPILOT_STATE_COMMENT_AUTHORS";

export function getTrustedStateCommentAuthors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // Check the action input first (highest priority) so operators can set the
  // value via a repository variable mapped through the action's
  // `looppilot-state-comment-authors` input without also needing to inject
  // the env var directly. Outside GitHub Actions, core.getInput returns "".
  const fromInput = core.getInput("looppilot-state-comment-authors");
  const raw = fromInput !== "" ? fromInput : (env[TRUSTED_STATE_AUTHORS_ENV] ?? "");
  const parsed = raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  return parsed.length > 0 ? parsed : [DEFAULT_TRUSTED_STATE_AUTHOR];
}

export function buildTrustedAuthorJqFilter(authors: string[]): string {
  // The jq expression must be safe to splice into the larger filter. GitHub
  // usernames are restricted to `[A-Za-z0-9_-]` plus the `[bot]` suffix on bot
  // accounts; no jq metacharacters can appear, but we still validate
  // defensively so a future env-driven author cannot inject jq syntax.
  const safe = authors.filter((a) => /^[A-Za-z0-9_\-]+(?:\[bot\])?$/.test(a));
  if (safe.length === 0) return "false";
  return safe.map((a) => `.user.login == "${a}"`).join(" or ");
}

/**
 * Runtime validation for deserialized state to prevent state tampering
 * via maliciously crafted PR comment bodies.
 *
 * All fields consumed downstream are validated to their expected types.
 * Nullable fields must be either the correct type or null.
 */
function validateState(obj: unknown): obj is ReviewState {
  if (typeof obj !== "object" || obj === null) return false;
  const s = obj as Record<string, unknown>;

  // TY-275 #5: `typeof Infinity === "number"` and `Number.isInteger(1e308) === true`
  // both pass the naive checks, so a hand-edited state with `Infinity` / `NaN` /
  // `1e308` would slip through and force-trigger `max_iterations` immediately.
  // `Number.isSafeInteger` rejects non-finite, fractional, AND values outside
  // [-2^53+1, 2^53-1] (which `Number.isInteger` accepts).
  if (!Number.isSafeInteger(s.iterationCount) || (s.iterationCount as number) < 0) return false;
  if (typeof s.status !== "string" || !VALID_STATUSES.has(s.status)) return false;
  if (!Array.isArray(s.findingsHashHistory)) return false;

  // Validate nullable fields used in downstream comparisons and Date parsing.
  // ES-426 #4: use Number.isSafeInteger (not `typeof === "number"`) so a
  // hand-edited state with a fractional or out-of-safe-range value (e.g. `1.5`,
  // `1e308`) cannot slip through. (Literal NaN/Infinity are not JSON-
  // representable, so JSON.parse rejects those before validateState runs; the
  // reachable threats are non-integer / out-of-range.) A bad value would break
  // the (id, source) dedup, silently re-processing a legitimate trigger.
  if (s.lastProcessedReviewId !== null && !Number.isSafeInteger(s.lastProcessedReviewId)) return false;
  // TY-301 #2: lastProcessedTriggerSource was added after the initial release.
  // Tolerate missing and explicit-null shapes; present values must be one of
  // the known sources so a forged state cannot smuggle in arbitrary strings
  // that would silently change dedup behaviour.
  if (
    "lastProcessedTriggerSource" in s &&
    s.lastProcessedTriggerSource !== null &&
    s.lastProcessedTriggerSource !== "comment" &&
    s.lastProcessedTriggerSource !== "review"
  ) {
    return false;
  }
  // TY-339 #1: bound the length so a tampered SHA cannot break the
  // serializeState step-3 floor guarantee.
  if (
    s.lastClaudeCommitSha !== null &&
    (typeof s.lastClaudeCommitSha !== "string" ||
      s.lastClaudeCommitSha.length > LAST_CLAUDE_COMMIT_SHA_MAX_CHARS)
  ) {
    return false;
  }
  // ES-426 #4: Number.isSafeInteger guard (see lastProcessedReviewId above).
  if (s.lastCodexRequestCommentId !== null && !Number.isSafeInteger(s.lastCodexRequestCommentId)) return false;
  // TY-339 #1 follow-up: bound the length (see TIMESTAMP_MAX_CHARS) so a
  // tampered timestamp cannot break the serializeState step-3 floor guarantee.
  if (
    s.lastCodexReviewReceivedAt !== null &&
    (typeof s.lastCodexReviewReceivedAt !== "string" ||
      s.lastCodexReviewReceivedAt.length > TIMESTAMP_MAX_CHARS)
  ) {
    return false;
  }
  // TY-339 #1: same length bound for the findings hash (16 hex in normal use).
  if (
    s.lastFindingsHash !== null &&
    (typeof s.lastFindingsHash !== "string" ||
      s.lastFindingsHash.length > FINDINGS_HASH_MAX_CHARS)
  ) {
    return false;
  }
  // TY-339 #1: validate `stopReason` against the `StopReason` union (symmetric
  // with the `lastProcessedTriggerSource` / `modelTier` enum checks) rather
  // than accepting any string. This bounds its length for the serialize floor
  // and stops a forged state from smuggling in an arbitrary stopReason.
  if (
    s.stopReason !== null &&
    (typeof s.stopReason !== "string" || !VALID_STOP_REASONS.has(s.stopReason))
  ) {
    return false;
  }
  // previousCheckFailure was added after the initial release; tolerate both
  // missing and explicit-null/string shapes. Missing is normalized to null below.
  if (
    "previousCheckFailure" in s &&
    s.previousCheckFailure !== null &&
    typeof s.previousCheckFailure !== "string"
  ) {
    return false;
  }
  // TY-275 #9: writes go through `truncatePreviousCheckFailure` (cap
  // PREVIOUS_CHECK_FAILURE_MAX_CHARS), but a hand-edited or legacy state
  // comment can carry an oversized blob that would push `serializeState`
  // over the 65,536-char GitHub comment-body limit. Reject upstream.
  if (
    typeof s.previousCheckFailure === "string" &&
    s.previousCheckFailure.length > PREVIOUS_CHECK_FAILURE_READ_LIMIT
  ) {
    return false;
  }
  // TY-273 #B4: fixingStartedAt was added after the initial release; tolerate
  // missing and explicit-null/string shapes. Missing is normalized to null
  // below so legacy state comments still satisfy the type.
  if (
    "fixingStartedAt" in s &&
    s.fixingStartedAt !== null &&
    (typeof s.fixingStartedAt !== "string" ||
      // TY-339 #1 follow-up: same length bound as lastCodexReviewReceivedAt —
      // the step-3 floor keeps fixingStartedAt verbatim too.
      s.fixingStartedAt.length > TIMESTAMP_MAX_CHARS)
  ) {
    return false;
  }
  // TY-360: currentIterationFindingCommentIds was added after the initial
  // release; tolerate missing (legacy) and explicit shapes. When present it
  // must be a bounded array of non-negative safe-integer comment ids so a
  // forged state cannot smuggle in a huge array (serialize-floor DoS) or
  // non-numeric thread targets. Missing is normalized to `[]` below.
  if ("currentIterationFindingCommentIds" in s) {
    const ids = s.currentIterationFindingCommentIds;
    if (!Array.isArray(ids) || ids.length > MAX_FINDING_COMMENT_IDS) return false;
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || (id as number) < 0) return false;
    }
  }

  // Validate each hash history entry shape
  for (const entry of s.findingsHashHistory) {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    // TY-339 #1: bound `hash` length (16 hex in normal use) so a tampered
    // history entry cannot break the serializeState step-3 floor guarantee.
    // ES-426 #4: Number.isSafeInteger guard for the entry iteration — a NaN/
    // Infinity here breaks rollbackFixingClaim (lastEntry.iteration === count)
    // and loop detection.
    if (
      !Number.isSafeInteger(e.iteration) ||
      typeof e.hash !== "string" ||
      e.hash.length > FINDINGS_HASH_MAX_CHARS
    ) {
      return false;
    }
    // modelTier was added by TY-243. Missing is tolerated for backward
    // compatibility (treated as `"escalated"` by `loop-detector`); present
    // values must be one of the known tiers.
    if (
      "modelTier" in e &&
      e.modelTier !== undefined &&
      e.modelTier !== "base" &&
      e.modelTier !== "escalated"
    ) {
      return false;
    }
  }

  return true;
}

export function createInitialState(): ReviewState {
  return {
    iterationCount: 0,
    lastProcessedReviewId: null,
    lastProcessedTriggerSource: null,
    lastClaudeCommitSha: null,
    lastCodexRequestCommentId: null,
    lastCodexReviewReceivedAt: null,
    lastFindingsHash: null,
    findingsHashHistory: [],
    status: "initialized",
    stopReason: null,
    previousCheckFailure: null,
    fixingStartedAt: null,
    currentIterationFindingCommentIds: [],
  };
}

/**
 * `previousCheckFailure` is the largest variable-size field — write-time
 * `truncatePreviousCheckFailure` caps it at `PREVIOUS_CHECK_FAILURE_MAX_CHARS`
 * but legacy / hand-edited state can carry up to `PREVIOUS_CHECK_FAILURE_READ_LIMIT`
 * (2× that cap). When the body is still over `MAX_SERIALIZED_BYTES` after
 * trimming `findingsHashHistory` to one entry, re-truncate
 * `previousCheckFailure` to this smaller budget before giving up on it.
 */
const PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS = 4000;

/**
 * Wraps ReviewState JSON in a hidden HTML comment for storage in GitHub PR comments.
 *
 * The serialized body is bounded by `MAX_SERIALIZED_BYTES` so the eventual
 * `updateStateComment` PATCH never trips GitHub's 65,536-char comment-body
 * limit. The pre-TY-287 fallback only trimmed `findingsHashHistory` to 1
 * entry, leaving a 35,000-char legacy `previousCheckFailure` capable of
 * pushing the minimal body past the limit and crashing pre-fix with a
 * non-actionable `state_corrupted` (the PATCH returns 422, which is not a
 * `StateUpdateConflictError`, so it propagates past `updateStateCommentLocked`).
 *
 * The TY-287 fallback chain (each step only runs when the previous one is
 * still over budget):
 *
 *   1. Trim `findingsHashHistory` to `MAX_HISTORY_ENTRIES` (normal path).
 *   2. Trim history to 1 entry and re-truncate `previousCheckFailure` to
 *      `PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS` using the existing head/tail
 *      `truncatePreviousCheckFailure` helper, which preserves the most
 *      actionable lines (first errors + last assertion).
 *   3. Drop `previousCheckFailure` to `null` so the body shape is bounded
 *      by the remaining fixed-size fields. This is the floor — every other
 *      field is fixed-size or already bounded by `validateState`.
 */
export function serializeState(state: ReviewState): string {
  const wrap = (s: ReviewState): string => {
    const json = JSON.stringify(s, null, 2);
    return (
      STATE_COMMENT_VISIBLE_TEXT +
      "\n\n" +
      STATE_COMMENT_OPEN +
      "\n" +
      json +
      "\n" +
      STATE_COMMENT_CLOSE
    );
  };

  // TY-360: clamp the comment-id array on the write path so an in-memory state
  // (which never passes through `validateState`) cannot serialize an over-budget
  // body. Producers stay well under the cap (`selectEmbeddedFindings` is bounded
  // by MAX_FINDINGS_PER_REQUEST = 30), so this only ever fires on a bug.
  const boundedState: ReviewState =
    state.currentIterationFindingCommentIds.length > MAX_FINDING_COMMENT_IDS
      ? {
          ...state,
          currentIterationFindingCommentIds:
            state.currentIterationFindingCommentIds.slice(
              0,
              MAX_FINDING_COMMENT_IDS,
            ),
        }
      : state;

  // Step 1: normal path — keep up to MAX_HISTORY_ENTRIES of history.
  const step1: ReviewState = {
    ...boundedState,
    findingsHashHistory:
      boundedState.findingsHashHistory.slice(-MAX_HISTORY_ENTRIES),
  };
  const body1 = wrap(step1);
  if (body1.length <= MAX_SERIALIZED_BYTES) return body1;

  // Step 2: shrink history to 1 entry AND aggressively trim a legacy
  // oversized previousCheckFailure to the fallback budget.
  const step2: ReviewState = {
    ...boundedState,
    findingsHashHistory: boundedState.findingsHashHistory.slice(-1),
    previousCheckFailure: boundedState.previousCheckFailure
      ? truncatePreviousCheckFailure(
          boundedState.previousCheckFailure,
          PREVIOUS_CHECK_FAILURE_FALLBACK_CHARS,
        )
      : null,
  };
  const body2 = wrap(step2);
  if (body2.length <= MAX_SERIALIZED_BYTES) return body2;

  // Step 3: pathological floor — drop previousCheckFailure entirely. Every
  // other field is fixed-size (or bounded by validateState upstream), so
  // this guarantees the body fits.
  const step3: ReviewState = {
    ...boundedState,
    findingsHashHistory: boundedState.findingsHashHistory.slice(-1),
    previousCheckFailure: null,
  };
  return wrap(step3);
}

/**
 * Extracts ReviewState from a GitHub comment body that contains the hidden state marker.
 * Returns null if the marker is absent or the embedded JSON is invalid.
 */
export function deserializeState(commentBody: string): ReviewState | null {
  // Escape special regex chars in the open/close delimiters
  const escapedOpen = STATE_COMMENT_OPEN.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const escapedClose = STATE_COMMENT_CLOSE.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const pattern = new RegExp(
    escapedOpen + "\\n([\\s\\S]*?)\\n" + escapedClose,
  );

  const match = commentBody.match(pattern);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]);
    if (!validateState(parsed)) {
      return null;
    }
    // Normalize fields added after the initial release so consumers
    // can rely on them being present (null when absent in old state comments).
    const normalized: ReviewState = {
      ...(parsed as ReviewState),
      previousCheckFailure:
        (parsed as { previousCheckFailure?: string | null }).previousCheckFailure ?? null,
      fixingStartedAt:
        (parsed as { fixingStartedAt?: string | null }).fixingStartedAt ?? null,
      // TY-301 #2: legacy state comments lack this field. Normalize to `null`
      // so the dedup check in pre-fix falls back to id-only comparison
      // (preserving the pre-TY-301 behaviour for in-flight PRs).
      lastProcessedTriggerSource:
        (parsed as { lastProcessedTriggerSource?: "comment" | "review" | null })
          .lastProcessedTriggerSource ?? null,
      // TY-360: legacy state comments lack this field. Normalize to `[]` so
      // post-fix can rely on it being a real array (no resolve targets) instead
      // of guarding for undefined.
      currentIterationFindingCommentIds:
        (parsed as { currentIterationFindingCommentIds?: number[] })
          .currentIterationFindingCommentIds ?? [],
    };
    return normalized;
  } catch {
    return null;
  }
}

export type ReadStateResult =
  | { found: true; corrupted: false; state: ReviewState; commentId: number; commentUpdatedAt: string }
  | { found: false; corrupted: false; commentId: null }
  | { found: false; corrupted: true; commentId: number | null; commentUpdatedAt?: string };

type StateCommentRecord = { id: number; body: string; updatedAt: string };

export interface UpdateStateCommentOptions {
  expectedUpdatedAt?: string;
}

export interface UpdateStateCommentResult {
  updatedAt: string;
}

export class StateUpdateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUpdateConflictError";
  }
}

export function parseStateCommentRecord(line: string): StateCommentRecord | null {
  function isRecord(value: unknown): value is { id: number; body: string; updated_at: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).id === "number" &&
      typeof (value as Record<string, unknown>).body === "string" &&
      typeof (value as Record<string, unknown>).updated_at === "string"
    );
  }

  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      return { id: parsed.id, body: parsed.body, updatedAt: parsed.updated_at };
    }
    if (typeof parsed === "string") {
      const nested = JSON.parse(parsed) as unknown;
      if (isRecord(nested)) {
        return { id: nested.id, body: nested.body, updatedAt: nested.updated_at };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Reads state from GitHub PR issue comments by scanning for the hidden state marker.
 * Uses gh api with --paginate to handle PRs with many comments.
 *
 * Returns a discriminated union:
 * - `{ found: true, state, commentId }` — state read successfully
 * - `{ found: false, corrupted: false, commentId: null }` — no hidden comment exists
 * - `{ found: false, corrupted: true, commentId }` — hidden comment exists but JSON is invalid
 */
export async function readState(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<ReadStateResult> {
  const authorFilter = buildTrustedAuthorJqFilter(getTrustedStateCommentAuthors());
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      // Filter to genuine state comments by anchoring on the visible header.
      // Using `startswith(VISIBLE_TEXT)` rather than the marker line keeps two
      // properties:
      //   1. Comments that merely mention `<!-- looppilot-state` inline
      //      (e.g., the Linear linkback that quotes it in backticks) are
      //      excluded — they do not start with the visible header.
      //   2. State comments where the trailing newline after the marker has
      //      been stripped (manual edits / formatter mangling) are still
      //      surfaced — `deserializeState` then determines whether the JSON
      //      is recoverable, so corruption recovery and `/restart-review` can
      //      proceed instead of silent skip.
      // The additional `contains(MARKER)` guards against the rare case where a
      // user writes a comment that legitimately begins with the visible text
      // but is not a state comment.
      // The `.user.login` author filter (TY-272 #A) discards comments posted
      // by anyone other than the trusted writer identity so a third-party
      // commenter on a public PR cannot inject a forged "latest" state.
      // @json emits each match as a single-line JSON-encoded string so
      // split("\n") parsing below stays correct.
      `.[] | select(${authorFilter}) | select(.body | startswith("${STATE_COMMENT_VISIBLE_TEXT}")) | select(.body | contains("${STATE_COMMENT_OPEN}")) | {id: .id, body: .body, updated_at: .updated_at} | @json`,
    ],
    token,
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { found: false, corrupted: false, commentId: null };
  }

  // @json wraps each result as a JSON-encoded string on its own line; double-decode to get the object.
  // Take the LAST line: if duplicate state comments exist, the most recent (highest ID) is last
  // because GitHub API returns issue comments in ascending chronological order.
  const lines = trimmed.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1];
  const parsed = parseStateCommentRecord(lastLine);
  if (!parsed) {
    return { found: false, corrupted: true, commentId: null };
  }

  const state = deserializeState(parsed.body);
  if (!state) {
    return { found: false, corrupted: true, commentId: parsed.id, commentUpdatedAt: parsed.updatedAt };
  }

  return { found: true, corrupted: false, state, commentId: parsed.id, commentUpdatedAt: parsed.updatedAt };
}

/**
 * Creates a new issue comment on the PR containing the serialized state.
 * Returns the new comment's numeric ID.
 */
export async function createStateComment(
  owner: string,
  name: string,
  pr: number,
  state: ReviewState,
  token: string,
): Promise<number> {
  const body = serializeState(state);
  const stdout = await ghApi(
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      // TY-269: see comment-poster.ts; `--raw-field` avoids gh CLI's
      // `@<value>` file-read interpretation for state-comment bodies.
      "--raw-field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    token,
  );

  const commentId = parseInt(stdout.trim(), 10);
  if (isNaN(commentId)) {
    throw new Error(
      `createStateComment: unexpected response from GitHub API: ${stdout.trim()}`,
    );
  }
  return commentId;
}

/**
 * Updates an existing issue comment with the serialized state via PATCH.
 */
export async function updateStateComment(
  owner: string,
  name: string,
  commentId: number,
  state: ReviewState,
  token: string,
  options: UpdateStateCommentOptions = {},
): Promise<UpdateStateCommentResult> {
  const body = serializeState(state);
  const trimmedState = deserializeState(body);
  if (!trimmedState) {
    throw new Error("updateStateComment: serializeState produced an undeserializable payload");
  }
  const expectedUpdatedAt = options.expectedUpdatedAt;

  if (expectedUpdatedAt !== undefined) {
    const latest = await fetchStateComment(owner, name, commentId, token);
    if (latest.updatedAt !== expectedUpdatedAt) {
      throw new StateUpdateConflictError(
        `Hidden comment updated_at changed before PATCH (expected ${expectedUpdatedAt}, actual ${latest.updatedAt})`,
      );
    }
  }

  const patched = await patchStateComment(owner, name, commentId, body, token, expectedUpdatedAt);
  const patchedState = deserializeState(patched.body);
  if (!patchedState || JSON.stringify(patchedState) !== JSON.stringify(trimmedState)) {
    throw new Error("PATCH response did not contain the expected hidden comment state");
  }

  return { updatedAt: patched.updatedAt };
}

async function fetchStateComment(
  owner: string,
  name: string,
  commentId: number,
  token: string,
): Promise<{ body: string; updatedAt: string }> {
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--jq",
      "{body: .body, updated_at: .updated_at} | @json",
    ],
    token,
  );
  return parseCommentSnapshot(stdout.trim(), "fetchStateComment");
}

async function patchStateComment(
  owner: string,
  name: string,
  commentId: number,
  body: string,
  token: string,
  expectedUpdatedAt?: string,
): Promise<{ body: string; updatedAt: string }> {
  const args = [
    "api",
    "--method",
    "PATCH",
    `repos/${owner}/${name}/issues/comments/${commentId}`,
    // TY-269: see comment-poster.ts; `--raw-field` skips gh CLI's `@<value>`
    // file-read interpretation so state-comment bodies cannot be mis-parsed
    // if they ever start with `@`.
    "--raw-field",
    `body=${body}`,
    "--jq",
    "{body: .body, updated_at: .updated_at} | @json",
  ];

  // Note: TY-139 originally added an `If-Unmodified-Since` header here for
  // server-side conflict detection, but GitHub's issue-comment PATCH does
  // not appear to honour this conditional reliably (real dogfood on PR #33
  // produced a 4xx on every state mutation, leaving the loop deadlocked at
  // `waiting_codex`). The preflight GET in `updateStateComment` still catches
  // the common multi-second race window; if a sub-second TOCTOU race occurs
  // the worst case is one stale write that the next iteration overwrites,
  // not silent corruption. Re-introducing server-side enforcement requires a
  // GitHub mechanism that actually works for this endpoint (e.g. ETag /
  // If-Match if it ever ships).

  let stdout: string;
  try {
    stdout = await ghApi(args, token);
  } catch (err: unknown) {
    // `ghApi` always rejects with an Error whose message combines
    // err.message / stderr / stdout, so 412 can surface in any of the three.
    const fullMessage = err instanceof Error ? err.message : String(err);
    if (
      expectedUpdatedAt !== undefined &&
      (fullMessage.includes("412") || fullMessage.includes("Precondition Failed"))
    ) {
      throw new StateUpdateConflictError(
        `Hidden comment was modified concurrently (expectedUpdatedAt=${expectedUpdatedAt}): ${fullMessage}`,
      );
    }
    throw err instanceof Error ? err : new Error(fullMessage);
  }

  return parseCommentSnapshot(stdout.trim(), "patchStateComment");
}

function parseCommentSnapshot(stdout: string, context: string): { body: string; updatedAt: string } {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const value = typeof parsed === "string" ? JSON.parse(parsed) as unknown : parsed;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).body === "string" &&
      typeof (value as Record<string, unknown>).updated_at === "string"
    ) {
      return {
        body: (value as { body: string; updated_at: string }).body,
        updatedAt: (value as { body: string; updated_at: string }).updated_at,
      };
    }
  } catch {
    // Fall through to uniform error below.
  }
  throw new Error(`${context}: unexpected response from GitHub API: ${stdout}`);
}
