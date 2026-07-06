import * as core from "@actions/core";
import { ghApi } from "./gh.js";
import { botLoginMatches } from "./bot-login.js";
import { postCodexReviewRequest as defaultPostCodexReviewRequest } from "./comment-poster.js";

/**
 * TY-334: in-job ACK polling for `@codex review`.
 *
 * The auto-review loop is fully event-driven: after posting `@codex review`
 * the job ends and only restarts when Codex posts its review. If Codex never
 * picks up the request (no 👀 reaction, no review), no restart event ever
 * fires and the hidden state is stuck at `waiting_codex` forever until an
 * operator manually runs `/restart-review`.
 *
 * `ensureCodexAck` closes that gap while the original job is still alive: it
 * polls for an acknowledgement and, if none arrives within `timeoutSeconds`,
 * reposts `@codex review` up to `maxReposts` times. A cron monitor was
 * rejected because GitHub cron has a 5-minute floor (10–15 min under load),
 * far slower than the ~90s recovery this needs. Jobs that crash entirely are
 * covered separately by TY-282 / TY-283.
 *
 * Acknowledgement is either:
 *   - a 👀 (eyes) reaction by the Codex bot on the request comment, or
 *   - any new Codex bot activity (comment) since the request timestamp — Codex
 *     is already running, so reposting would only cause a duplicate review.
 *
 * Re-trigger safety: a reposted `@codex review` is authored by the
 * codex-review-request-token user, not the Codex bot, so Workflow B's trigger
 * filter (Codex-bot author + review marker) never matches it — the repost
 * cannot recursively start another Workflow B run.
 */

export interface CodexAckParams {
  owner: string;
  repo: string;
  pr: number;
  /** The `@codex review` comment id whose reactions are polled for the ACK. */
  commentId: number;
  /** ISO timestamp of the request; Codex activity after this counts as ACK. */
  requestedAt: string;
  codexBotLogin: string;
  /** Token used to read reactions/comments/reviews (e.g. GITHUB_TOKEN with pull_requests:read). */
  readToken: string;
  /** Token used to repost `@codex review` (e.g. CODEX_REVIEW_REQUEST_TOKEN). */
  token: string;
  /** Per-attempt poll window. `<= 0` disables ACK polling entirely. */
  timeoutSeconds: number;
  pollIntervalSeconds: number;
  /** Hard cap on reposts. `0` polls once and never reposts. */
  maxReposts: number;
}

export type CodexAckReason = "eyes" | "new_activity" | "exhausted" | "disabled";

export interface CodexAckResult {
  acked: boolean;
  reason: CodexAckReason;
  /** Number of `@codex review` reposts performed (0 when acked on first window). */
  reposts: number;
  /** Latest `@codex review` comment id — differs from the input when reposted. */
  lastCommentId: number;
}

export interface CodexAckDeps {
  /** Logins of users who reacted 👀 (eyes) on the comment. */
  getEyesReactors: (
    owner: string,
    repo: string,
    commentId: number,
    token: string,
  ) => Promise<string[]>;
  /** True when the Codex bot posted any new comment or pull_request_review since `sinceIso`. */
  hasNewCodexActivity: (
    owner: string,
    repo: string,
    pr: number,
    codexBotLogin: string,
    sinceIso: string,
    token: string,
  ) => Promise<boolean>;
  postCodexReviewRequest: (
    owner: string,
    repo: string,
    pr: number,
    token: string,
  ) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  info: (message: string) => void;
  warning: (message: string) => void;
}

export const defaultCodexAckDeps: CodexAckDeps = {
  getEyesReactors: async (owner, repo, commentId, token) => {
    const out = await ghApi(
      [
        "api",
        "--paginate",
        `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
        "-H",
        "Accept: application/vnd.github+json",
        "--jq",
        '.[] | select(.content == "eyes") | .user.login',
      ],
      token,
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  hasNewCodexActivity: async (owner, repo, pr, codexBotLogin, sinceIso, token) => {
    // `since` filters issue comments by updated_at, NOT created_at. An *edit*
    // to an older Codex comment (e.g. the previous iteration's review summary)
    // bumps updated_at and resurfaces it inside the window, which would be a
    // false ACK (TY-339 #2). So we use `since` only to narrow the fetch range
    // and gate on created_at in JS — mirroring the reviews path below, which
    // already compares submitted_at. We fetch login + created_at only and
    // match the Codex bot login in JS to avoid interpolating it into the jq
    // program string.
    const commentsOut = await ghApi(
      [
        "api",
        "--paginate",
        `repos/${owner}/${repo}/issues/${pr}/comments?since=${encodeURIComponent(sinceIso)}`,
        "--jq",
        '.[] | .user.login + "|" + (.created_at // "")',
      ],
      token,
    );
    if (
      commentsOut
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .some((line) => {
          const pipeIdx = line.indexOf("|");
          if (pipeIdx === -1) return false;
          const login = line.slice(0, pipeIdx);
          const createdAt = line.slice(pipeIdx + 1);
          // Date-compare (not lexicographic) for the same second/millisecond
          // precision reason documented on the reviews path below.
          return (
            botLoginMatches(login, codexBotLogin) &&
            new Date(createdAt).getTime() >= new Date(sinceIso).getTime()
          );
        })
    ) {
      return true;
    }

    // Also check pull_request_review events — Codex may respond with a PR
    // review rather than an issue comment. The reviews endpoint has no `since`
    // filter, so we fetch user.login + submitted_at and compare in JS.
    // per_page=100 (max) reduces paginated requests to O(N/100) vs O(N/30).
    const reviewsOut = await ghApi(
      [
        "api",
        "--paginate",
        `repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`,
        "--jq",
        '.[] | .user.login + "|" + (.submitted_at // "")',
      ],
      token,
    );
    return reviewsOut
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .some((line) => {
        const pipeIdx = line.indexOf("|");
        if (pipeIdx === -1) return false;
        const login = line.slice(0, pipeIdx);
        const submittedAt = line.slice(pipeIdx + 1);
        // Parse as Date objects: GitHub's submitted_at is second-precision
        // ("...43Z") while sinceIso carries milliseconds ("...43.500Z"), so
        // a lexicographic compare would incorrectly treat 43.000s as newer
        // than 43.500s (ASCII 'Z' > '.').
        return (
          botLoginMatches(login, codexBotLogin) &&
          new Date(submittedAt).getTime() >= new Date(sinceIso).getTime()
        );
      });
  },
  postCodexReviewRequest: defaultPostCodexReviewRequest,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  info: (message) => core.info(message),
  warning: (message) => core.warning(message),
};

/**
 * Polls a single window for an ACK. Returns the ACK reason, or `null` when the
 * window elapsed with no acknowledgement. IO errors are non-fatal: they are
 * logged and treated as "no signal yet" so a transient API blip cannot abort
 * the recovery — the window's timeout still bounds the wait.
 */
async function waitForAckWindow(
  params: CodexAckParams,
  deps: CodexAckDeps,
  commentId: number,
  requestedAt: string,
  pollIntervalMs: number,
): Promise<CodexAckReason | null> {
  const deadline = deps.now() + params.timeoutSeconds * 1000;
  for (;;) {
    try {
      const reactors = await deps.getEyesReactors(
        params.owner,
        params.repo,
        commentId,
        params.readToken,
      );
      if (reactors.some((r) => botLoginMatches(r, params.codexBotLogin))) {
        return "eyes";
      }
    } catch (error) {
      deps.warning(
        `[codex-ack] Failed to read reactions on comment ${commentId}: ${error instanceof Error ? error.message : String(error)}. Treating as no ACK yet.`,
      );
    }

    try {
      if (
        await deps.hasNewCodexActivity(
          params.owner,
          params.repo,
          params.pr,
          params.codexBotLogin,
          requestedAt,
          params.readToken,
        )
      ) {
        return "new_activity";
      }
    } catch (error) {
      deps.warning(
        `[codex-ack] Failed to check for new Codex activity: ${error instanceof Error ? error.message : String(error)}. Treating as no ACK yet.`,
      );
    }

    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return null;
    }
    await deps.sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function ensureCodexAck(
  params: CodexAckParams,
  deps: CodexAckDeps = defaultCodexAckDeps,
): Promise<CodexAckResult> {
  if (params.timeoutSeconds <= 0) {
    deps.info(
      "[codex-ack] ACK polling disabled (CODEX_ACK_TIMEOUT_SECONDS <= 0); skipping.",
    );
    return {
      acked: true,
      reason: "disabled",
      reposts: 0,
      lastCommentId: params.commentId,
    };
  }

  const pollIntervalMs = Math.max(1, params.pollIntervalSeconds) * 1000;
  let commentId = params.commentId;
  let requestedAt = params.requestedAt;
  let reposts = 0;

  for (;;) {
    const reason = await waitForAckWindow(
      params,
      deps,
      commentId,
      requestedAt,
      pollIntervalMs,
    );
    if (reason !== null) {
      deps.info(
        `[codex-ack] Codex acknowledged the review request (${reason}) after ${reposts} repost(s).`,
      );
      return { acked: true, reason, reposts, lastCommentId: commentId };
    }

    // Guard (b): the ACK check above already covers "review is arriving" via
    // hasNewCodexActivity, so we only reach here when nothing has come back.
    if (reposts >= params.maxReposts) {
      deps.warning(
        `[codex-ack] No Codex ACK after ${params.timeoutSeconds}s and ${reposts} repost(s) (max ${params.maxReposts}). Giving up.`,
      );
      return { acked: false, reason: "exhausted", reposts, lastCommentId: commentId };
    }

    const newRequestedAt = new Date(deps.now()).toISOString();
    try {
      commentId = await deps.postCodexReviewRequest(
        params.owner,
        params.repo,
        params.pr,
        params.token,
      );
    } catch (error) {
      deps.warning(
        `[codex-ack] Failed to repost @codex review: ${error instanceof Error ? error.message : String(error)}. Giving up.`,
      );
      return { acked: false, reason: "exhausted", reposts, lastCommentId: commentId };
    }
    requestedAt = newRequestedAt;
    reposts += 1;
    deps.info(
      `[codex-ack] No ACK within ${params.timeoutSeconds}s; reposted @codex review (attempt ${reposts}/${params.maxReposts}), new comment ${commentId}.`,
    );
  }
}
