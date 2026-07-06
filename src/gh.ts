import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGhEnv } from "./gh-env.js";

const execFileAsync = promisify(execFile);

/**
 * Buffer cap for `gh api` stdout. The Node default of 1 MB is insufficient
 * for paginated listings (PR comments, labels, etc.) on large PRs, so all
 * gh invocations share this 10 MB cap unless a caller overrides it.
 */
export const GH_MAX_BUFFER = 10 * 1024 * 1024;

export interface GhApiOptions {
  /** Override the default `GH_MAX_BUFFER` for this invocation. */
  maxBuffer?: number;
}

/**
 * Thin wrapper around `gh <args>` that injects the auth env and a unified
 * `maxBuffer`. Returns `stdout` as a UTF-8 string. On failure, combines
 * `err.message` / `err.stderr` / `err.stdout` (when present) into a single
 * `Error.message` so the caller and workflow logs see the full HTTP response
 * body. Specialized error handling (e.g., 412 → `StateUpdateConflictError`)
 * stays in the caller — `ghApi` does not interpret the response.
 */
export async function ghApi(
  args: string[],
  token: string,
  opts: GhApiOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      env: buildGhEnv(token),
      maxBuffer: opts.maxBuffer ?? GH_MAX_BUFFER,
    });
    return stdout;
  } catch (err: unknown) {
    const errIO = err as {
      stderr?: unknown;
      stdout?: unknown;
      message?: string;
    };
    const stderrText = errIO.stderr ? String(errIO.stderr) : "";
    const stdoutText = errIO.stdout ? String(errIO.stdout) : "";
    const baseMessage =
      errIO.message ?? (err instanceof Error ? err.message : String(err));
    const fullMessage = [
      baseMessage,
      stderrText && `stderr: ${stderrText.trim()}`,
      stdoutText && `stdout: ${stdoutText.trim()}`,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(fullMessage);
  }
}

/**
 * ES-426 #5: reads a PR's lifecycle state (`state` / `draft` / `merged`) from
 * `GET /repos/{owner}/{repo}/pulls/{pr}`. Shared by pre-fix and post-fix so the
 * jq + defensive parse live in one place. `.state` is `"open"`/`"closed"`
 * (draft is the separate `.draft` bool); `.merged` is the terminal bool.
 */
export async function fetchPrLifecycle(
  owner: string,
  repo: string,
  pr: number,
  token: string,
): Promise<{ state: string; draft: boolean; merged: boolean }> {
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${repo}/pulls/${pr}`,
      "--jq",
      "{state: .state, draft: (.draft // false), merged: (.merged // false)} | @json",
    ],
    token,
  );
  const parsed = JSON.parse(stdout.trim()) as {
    state?: unknown;
    draft?: unknown;
    merged?: unknown;
  };
  return {
    state: typeof parsed.state === "string" ? parsed.state : "",
    draft: parsed.draft === true,
    merged: parsed.merged === true,
  };
}
