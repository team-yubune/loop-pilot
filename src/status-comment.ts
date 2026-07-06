import { ghApi } from "./gh.js";
import {
  buildTrustedAuthorJqFilter,
  getTrustedStateCommentAuthors,
} from "./state-manager.js";

export const STATUS_COMMENT_MARKER = "looppilot-status";
const STATUS_COMMENT_OPEN = `<!-- ${STATUS_COMMENT_MARKER} -->`;
const STATUS_COMMENT_DATA_OPEN = `<!-- ${STATUS_COMMENT_MARKER}-data`;
const STATUS_COMMENT_DATA_CLOSE = "-->";
const STATUS_COMMENT_VISIBLE_HEADER = "## LoopPilot status";
const MAX_ENTRIES = 30;
// GitHub issue-comment body limit is 65 536 characters. Each entry body appears
// twice in the rendered comment (visible history + hidden JSON data block), so
// we cap individual bodies to keep the total well within that limit.
//
// NOTE: the hidden data block base64-encodes the snapshot JSON, and base64
// length tracks the body's UTF-8 BYTE length, NOT its character count. A
// 16 000-character body of multi-byte (e.g. CJK) text is ~48 000 bytes →
// ~64 000 base64 chars, which — alongside the raw copy in the visible history —
// can push the rendered comment past `GITHUB_COMMENT_BODY_LIMIT`. To avoid
// silently wiping the history in that case, `renderStatusCommentBody` truncates
// (rather than drops) an over-budget newest entry as a backstop (TY-339).
const MAX_ENTRY_BODY_LENGTH = 16_000;
const ENTRY_BODY_TRUNCATION_MARKER = "\n\n_(output truncated — exceeded size limit)_";

const GITHUB_COMMENT_BODY_LIMIT = 65_536;

/** History entry kinds; carried in the JSON so future UI variants can pick. */
export type StatusEntryKind =
  | "auto_fix_applied"
  | "completed"
  | "stopped"
  | "test_failure"
  | "init_incomplete";

export interface StatusEntry {
  /** ISO-8601 timestamp at write time; rendered next to the entry title. */
  timestamp: string;
  kind: StatusEntryKind;
  /** Short title rendered as the `### ...` line for the entry. */
  title: string;
  /** Markdown body for the entry. */
  body: string;
}

export interface StatusSnapshot {
  /** One-line "current" summary rendered at the top of the comment. */
  current: string;
  /** Optional last commit SHA (short or full); `null` renders as `—`. */
  lastCommit: string | null;
  /** Open in-scope findings count (severities at or above the configured threshold); `null` renders as `—`. */
  openFindings: number | null;
  /** Suggested next human action. */
  nextAction: string;
  /**
   * Current iteration count (TY-291 #3 / UX-09). `null` renders as `—`. Both
   * `iterationCount` and `maxIterations` need a value to render the
   * `Iterations` header row; otherwise the row is omitted.
   */
  iterationCount: number | null;
  /** Configured iteration cap (MAX_REVIEW_ITERATIONS). */
  maxIterations: number | null;
  /** Tier used for the most recent repair iteration. `null` renders as `—`. */
  lastModelTier: "base" | "escalated" | null;
  /** Newest entries first; capped at `MAX_ENTRIES`. */
  entries: StatusEntry[];
}

export function createInitialStatusSnapshot(): StatusSnapshot {
  return {
    current: "—",
    lastCommit: null,
    openFindings: null,
    nextAction: "—",
    iterationCount: null,
    maxIterations: null,
    lastModelTier: null,
    entries: [],
  };
}

function renderEntry(entry: StatusEntry): string {
  return `### ${entry.title}\n*${entry.timestamp}*\n\n${entry.body}`;
}

function renderStatusCommentBodyUnchecked(snapshot: StatusSnapshot): string {
  const headerRows: string[] = [
    STATUS_COMMENT_OPEN,
    STATUS_COMMENT_VISIBLE_HEADER,
    "",
    `**Current**: ${snapshot.current}`,
    `**Last commit**: ${snapshot.lastCommit ?? "—"}`,
  ];
  // TY-291 #3 (UX-09): surface iteration budget + model tier so operators can
  // read the cost / progress state from the PR alone. Both rows are omitted for
  // legacy snapshots that pre-date the fields (`null` × `null`) to keep the
  // header compact when there is nothing useful to show.
  if (snapshot.iterationCount !== null || snapshot.maxIterations !== null) {
    const iter = snapshot.iterationCount ?? "—";
    const cap = snapshot.maxIterations ?? "—";
    headerRows.push(`**Iterations**: ${iter} / ${cap}`);
    // Always render when iteration budget is present — null means "no repair yet" → show "—"
    // rather than hiding the row and leaving the progress header incomplete.
    headerRows.push(`**Last model tier**: ${snapshot.lastModelTier ?? "—"}`);
  } else if (snapshot.lastModelTier !== null) {
    // Legacy snapshots without iteration fields: only show tier if it was already set.
    headerRows.push(`**Last model tier**: ${snapshot.lastModelTier}`);
  }
  headerRows.push(`**Open findings**: ${snapshot.openFindings ?? "—"}`);
  headerRows.push(`**Next action**: ${snapshot.nextAction}`);
  headerRows.push("");
  const header = headerRows.join("\n");

  const historyBody =
    snapshot.entries.length === 0
      ? "_(no entries yet)_"
      : snapshot.entries.map(renderEntry).join("\n\n");

  const history = [
    "<details>",
    `<summary>History (${snapshot.entries.length} ${snapshot.entries.length === 1 ? "entry" : "entries"})</summary>`,
    "",
    historyBody,
    "",
    "</details>",
    "",
  ].join("\n");

  // TY-269 #14: base64-encode the JSON payload so that arbitrary entry bodies
  // (CHECK_COMMAND tail, stack traces, etc.) can never collide with the HTML
  // comment delimiter or the data-block marker. Base64 output is ASCII without
  // `-`, `<`, or `>`, so neither `-->` nor `<!-- looppilot-status-data` can
  // appear in the encoded payload. Visible history above stays as raw markdown
  // for human readability.
  const data = [
    STATUS_COMMENT_DATA_OPEN,
    encodePayload(JSON.stringify(snapshot)),
    STATUS_COMMENT_DATA_CLOSE,
  ].join("\n");

  return `${header}\n${history}\n${data}\n`;
}

const PAYLOAD_PREFIX = "b64:";

function encodePayload(json: string): string {
  return PAYLOAD_PREFIX + Buffer.from(json, "utf8").toString("base64");
}

/**
 * Decode a base64-prefixed payload, returning the JSON string. Returns `null`
 * on any decode failure so callers can fall back to legacy parsing.
 */
function decodePayload(raw: string): string | null {
  if (!raw.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    return Buffer.from(raw.slice(PAYLOAD_PREFIX.length), "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

export function renderStatusCommentBody(snapshot: StatusSnapshot): string {
  // Step 1: trim oldest entries (last in newest-first array) until the rendered
  // body fits within GitHub's issue-comment character limit.  Each entry appears
  // twice — once in visible history and once inside the JSON data block — so
  // the aggregate size can far exceed per-entry caps alone.
  for (let count = snapshot.entries.length; count >= 1; count--) {
    const effective: StatusSnapshot =
      count === snapshot.entries.length
        ? snapshot
        : { ...snapshot, entries: snapshot.entries.slice(0, count) };
    const body = renderStatusCommentBodyUnchecked(effective);
    if (body.length <= GITHUB_COMMENT_BODY_LIMIT) return body;
  }

  // Step 2: even the single newest entry does not fit at full body. This
  // happens when an entry body is dominated by multi-byte (e.g. CJK) content:
  // the base64 data block encodes UTF-8 bytes, so the rendered size grows
  // faster than the char-based per-entry cap accounts for (see the note on
  // MAX_ENTRY_BODY_LENGTH). Dropping to zero entries here would silently
  // discard the newest entry — for a CHECK_COMMAND `test_failure` that is the
  // failure diagnostics operators most need, and its companion top-level
  // notification is link-only — AND every prior history entry. Instead, keep
  // the newest entry and truncate its body to the largest char prefix whose
  // single-entry render still fits.
  if (snapshot.entries.length > 0) {
    const newest = snapshot.entries[0];
    const renderWithBody = (body: string): string =>
      renderStatusCommentBodyUnchecked({
        ...snapshot,
        entries: [{ ...newest, body }],
      });
    const withMarker = (charCount: number): string =>
      charCount < newest.body.length
        ? newest.body.slice(0, charCount) + ENTRY_BODY_TRUNCATION_MARKER
        : newest.body;
    // Binary-search the largest char prefix that fits once rendered.
    let lo = 0;
    let hi = newest.body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (renderWithBody(withMarker(mid)).length <= GITHUB_COMMENT_BODY_LIMIT) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const body = renderWithBody(withMarker(lo));
    if (body.length <= GITHUB_COMMENT_BODY_LIMIT) return body;
  }

  // Step 3: floor — render with zero entries (header alone is always under the limit).
  return renderStatusCommentBodyUnchecked({ ...snapshot, entries: [] });
}

/**
 * Parse a status comment body back into its `StatusSnapshot`. Returns `null`
 * when the body is missing the data marker or has corrupted JSON. The hidden
 * JSON block is the source of truth — the rendered markdown is regenerated
 * from it on every update.
 */
export function parseStatusCommentBody(body: string): StatusSnapshot | null {
  // Scan forward through every occurrence of STATUS_COMMENT_DATA_OPEN and
  // keep the last one that yields a valid StatusSnapshot.  The data block is
  // always the final structural element, so the last successful parse is the
  // authoritative snapshot.  This correctly skips false matches inside:
  //   • visible history entry bodies (e.g. an entry whose output contains the
  //     marker string or the literal "</details>"), and
  //   • the JSON payload itself (when an entry body repeats the marker string,
  //     that string is serialised verbatim inside the JSON object).
  let result: StatusSnapshot | null = null;
  let searchFrom = 0;
  while (true) {
    const dataStart = body.indexOf(STATUS_COMMENT_DATA_OPEN, searchFrom);
    if (dataStart === -1) break;
    const afterOpen = body.slice(dataStart + STATUS_COMMENT_DATA_OPEN.length);
    const closeIdx = afterOpen.indexOf(STATUS_COMMENT_DATA_CLOSE);
    if (closeIdx !== -1) {
      const raw = afterOpen.slice(0, closeIdx).trim();
      // TY-269 #14: new format is `b64:<base64-json>`; legacy format inlines
      // the JSON with `-->` escaped as `--\>`. Try base64 first, fall back to
      // the legacy escape so in-flight status comments keep their history
      // across this rollout.
      const candidates: string[] = [];
      const decoded = decodePayload(raw);
      if (decoded !== null) candidates.push(decoded);
      candidates.push(raw.replace(/--\\>/g, "-->"));
      for (const jsonRaw of candidates) {
        try {
          const parsed: unknown = JSON.parse(jsonRaw);
          if (isStatusSnapshot(parsed)) {
            // TY-291 #3: legacy snapshots predate iterationCount /
            // maxIterations / lastModelTier. Normalise undefined → null so the
            // renderer's `null` check produces the legacy 4-row header instead
            // of `**Iterations**: undefined / —`.
            result = {
              ...parsed,
              iterationCount: parsed.iterationCount ?? null,
              maxIterations: parsed.maxIterations ?? null,
              lastModelTier: parsed.lastModelTier ?? null,
            };
            break;
          }
        } catch {
          // try the next candidate
        }
      }
    }
    searchFrom = dataStart + 1;
  }
  return result;
}

function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.current !== "string") return false;
  if (v.lastCommit !== null && typeof v.lastCommit !== "string") return false;
  if (v.openFindings !== null && typeof v.openFindings !== "number") return false;
  if (typeof v.nextAction !== "string") return false;
  // TY-291 #3 (UX-09): legacy snapshots predate iterationCount / maxIterations
  // / lastModelTier. Treat missing fields as `null` (preserves back-compat) but
  // reject explicit values of the wrong type so a malformed write surfaces in
  // tests instead of silently falling through.
  if (
    v.iterationCount !== undefined &&
    v.iterationCount !== null &&
    typeof v.iterationCount !== "number"
  )
    return false;
  if (
    v.maxIterations !== undefined &&
    v.maxIterations !== null &&
    typeof v.maxIterations !== "number"
  )
    return false;
  if (
    v.lastModelTier !== undefined &&
    v.lastModelTier !== null &&
    v.lastModelTier !== "base" &&
    v.lastModelTier !== "escalated"
  )
    return false;
  if (!Array.isArray(v.entries)) return false;
  for (const e of v.entries) {
    if (typeof e !== "object" || e === null) return false;
    const en = e as Record<string, unknown>;
    if (typeof en.timestamp !== "string") return false;
    if (typeof en.title !== "string") return false;
    if (typeof en.body !== "string") return false;
    if (
      en.kind !== "auto_fix_applied" &&
      en.kind !== "completed" &&
      en.kind !== "stopped" &&
      en.kind !== "test_failure" &&
      en.kind !== "init_incomplete"
    )
      return false;
  }
  return true;
}

export interface StatusUpdate {
  /** Optional next snapshot header fields. Each undefined field is preserved. */
  current?: string;
  lastCommit?: string | null;
  openFindings?: number | null;
  nextAction?: string;
  iterationCount?: number | null;
  maxIterations?: number | null;
  lastModelTier?: "base" | "escalated" | null;
  /** Optional entry to prepend to history (newest first). */
  newEntry?: StatusEntry;
}

function capEntryBody(body: string): string {
  if (body.length <= MAX_ENTRY_BODY_LENGTH) return body;
  return (
    body.slice(0, MAX_ENTRY_BODY_LENGTH - ENTRY_BODY_TRUNCATION_MARKER.length) +
    ENTRY_BODY_TRUNCATION_MARKER
  );
}

/**
 * Apply an update on top of an existing snapshot. Pure function; trims the
 * history at `MAX_ENTRIES`.
 */
export function applyStatusUpdate(
  snapshot: StatusSnapshot,
  update: StatusUpdate,
): StatusSnapshot {
  const cappedEntry = update.newEntry
    ? { ...update.newEntry, body: capEntryBody(update.newEntry.body) }
    : undefined;
  const entries = cappedEntry
    ? [cappedEntry, ...snapshot.entries].slice(0, MAX_ENTRIES)
    : snapshot.entries;
  return {
    current: update.current ?? snapshot.current,
    lastCommit:
      update.lastCommit === undefined ? snapshot.lastCommit : update.lastCommit,
    openFindings:
      update.openFindings === undefined
        ? snapshot.openFindings
        : update.openFindings,
    nextAction: update.nextAction ?? snapshot.nextAction,
    // TY-291 #3: same `undefined = preserve, null = clear` semantics as the
    // existing nullable fields so callers can leave iteration progress alone
    // when they have nothing to report.
    iterationCount:
      update.iterationCount === undefined
        ? snapshot.iterationCount
        : update.iterationCount,
    maxIterations:
      update.maxIterations === undefined
        ? snapshot.maxIterations
        : update.maxIterations,
    lastModelTier:
      update.lastModelTier === undefined
        ? snapshot.lastModelTier
        : update.lastModelTier,
    entries,
  };
}

interface StatusCommentRecord {
  id: number;
  body: string;
  /**
   * ES-426 #3: the comment's `updated_at`, used as the optimistic-lock token by
   * `upsertStatusComment`. Optional so hand-built dep stubs that omit it simply
   * skip the preflight compare (last-writer-wins, the pre-ES-426 behaviour).
   */
  updatedAt?: string;
}

function isStatusCommentRecord(value: unknown): value is StatusCommentRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.body === "string" &&
    (v.updatedAt === undefined || typeof v.updatedAt === "string")
  );
}

/**
 * ES-426 #3: raised when the status comment's `updated_at` changed between the
 * read and the PATCH, i.e. a concurrent writer slipped in. `upsertStatusComment`
 * catches it to re-read + re-merge so history entries are not clobbered.
 */
export class StatusCommentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusCommentConflictError";
  }
}

/**
 * Find an existing status comment on the PR, or return `null`. Identified by
 * presence of `STATUS_COMMENT_MARKER` in the body header.
 *
 * TY-272 #A: the jq filter additionally requires `.user.login` to match a
 * trusted bot author so a third-party commenter on a public PR cannot forge a
 * status comment whose `current` / `nextAction` confuses operators or whose
 * data block redirects upsert merges to attacker-controlled history.
 */
export async function findStatusComment(
  owner: string,
  name: string,
  pr: number,
  token: string,
): Promise<StatusCommentRecord | null> {
  const authorFilter = buildTrustedAuthorJqFilter(getTrustedStateCommentAuthors());
  const stdout = await ghApi(
    [
      "api",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      "--paginate",
      "--jq",
      `.[] | select(${authorFilter}) | select(.body | startswith("${STATUS_COMMENT_OPEN}")) | {id: .id, body: .body, updatedAt: .updated_at} | @json`,
    ],
    token,
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // If duplicates exist, take the newest (last line; gh paginate returns ascending).
  const lines = trimmed.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      // `@json` in jq produces a JSON-encoded string; unwrap one level if needed.
      const value =
        typeof parsed === "string" ? (JSON.parse(parsed) as unknown) : parsed;
      if (isStatusCommentRecord(value)) return value;
    } catch {
      continue;
    }
  }
  return null;
}

async function createStatusCommentImpl(
  owner: string,
  name: string,
  pr: number,
  body: string,
  token: string,
): Promise<number> {
  const stdout = await ghApi(
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${name}/issues/${pr}/comments`,
      // TY-269: `--raw-field` (= `-F`) avoids gh CLI's `@<value>` file-read
      // interpretation. Status-comment bodies are pre-rendered markdown and
      // could legitimately start with `@`.
      "--raw-field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    token,
  );
  const id = parseInt(stdout.trim(), 10);
  if (Number.isNaN(id)) {
    throw new Error(
      `createStatusComment: unexpected response from GitHub API: ${stdout.trim()}`,
    );
  }
  return id;
}

async function updateStatusCommentImpl(
  owner: string,
  name: string,
  commentId: number,
  body: string,
  token: string,
  expectedUpdatedAt?: string,
): Promise<void> {
  // ES-426 #3: preflight GET compares `updated_at` before the PATCH so a
  // concurrent writer that slipped in since the read is detected (GitHub's
  // issue-comment PATCH does not honour conditional requests reliably — see the
  // note in state-manager.patchStateComment — so this preflight is the same
  // best-effort compare the state comment uses). undefined skips the check.
  if (expectedUpdatedAt !== undefined) {
    const stdout = await ghApi(
      [
        "api",
        `repos/${owner}/${name}/issues/comments/${commentId}`,
        "--jq",
        ".updated_at",
      ],
      token,
    );
    const actual = stdout.trim();
    if (actual !== expectedUpdatedAt) {
      throw new StatusCommentConflictError(
        `Status comment updated_at changed before PATCH (expected ${expectedUpdatedAt}, actual ${actual})`,
      );
    }
  }
  await ghApi(
    [
      "api",
      "--method",
      "PATCH",
      `repos/${owner}/${name}/issues/comments/${commentId}`,
      "--raw-field",
      `body=${body}`,
      "--jq",
      ".id",
    ],
    token,
  );
}

export interface UpsertStatusCommentDeps {
  findStatusComment: typeof findStatusComment;
  createStatusComment: (
    owner: string,
    name: string,
    pr: number,
    body: string,
    token: string,
  ) => Promise<number>;
  updateStatusComment: (
    owner: string,
    name: string,
    commentId: number,
    body: string,
    token: string,
    expectedUpdatedAt?: string,
  ) => Promise<void>;
}

const defaultDeps: UpsertStatusCommentDeps = {
  findStatusComment,
  createStatusComment: createStatusCommentImpl,
  updateStatusComment: updateStatusCommentImpl,
};

/**
 * Find-or-create the LoopPilot status comment and apply `update`. When the
 * comment already exists, the previous snapshot is parsed from its hidden
 * JSON block and merged with `update` before rewriting the body. Returns the
 * comment ID so callers can correlate logs / tests.
 */
export async function upsertStatusComment(
  owner: string,
  name: string,
  pr: number,
  update: StatusUpdate,
  token: string,
  deps: UpsertStatusCommentDeps = defaultDeps,
): Promise<number> {
  // ES-426 #3: read → merge → PATCH is a read-modify-write on a comment that is
  // NOT the source of truth, so a concurrent writer between the read and the
  // PATCH would silently drop the other run's history entry. Guard the write
  // with the comment's `updated_at` (optimistic lock, same best-effort approach
  // as the state comment) and, on conflict, re-read + re-merge onto the
  // concurrent writer's latest body (applyStatusUpdate prepends our entry, so
  // both survive). The status comment is NOT the source of truth and this call
  // must stay best-effort — it must never THROW on contention (a throw would
  // abort a real terminal action, e.g. auto-merge, in an unwrapped caller). So
  // the final attempt writes unconditionally (last-writer-wins) after a fresh
  // re-read + re-merge, minimising — though not fully eliminating — history
  // loss. Non-conflict errors (network / 5xx) still propagate, matching the
  // pre-ES-426 `ghApi` behaviour.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const existing = await deps.findStatusComment(owner, name, pr, token);
    if (existing === null) {
      const snapshot = applyStatusUpdate(createInitialStatusSnapshot(), update);
      const body = renderStatusCommentBody(snapshot);
      return deps.createStatusComment(owner, name, pr, body, token);
    }
    const previousSnapshot =
      parseStatusCommentBody(existing.body) ?? createInitialStatusSnapshot();
    const snapshot = applyStatusUpdate(previousSnapshot, update);
    const body = renderStatusCommentBody(snapshot);
    // On the final attempt drop the optimistic lock (undefined skips the
    // preflight) so a persistent conflict resolves to a last-writer-wins write
    // instead of throwing.
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    try {
      await deps.updateStatusComment(
        owner,
        name,
        existing.id,
        body,
        token,
        isLastAttempt ? undefined : existing.updatedAt,
      );
      return existing.id;
    } catch (err) {
      if (err instanceof StatusCommentConflictError && !isLastAttempt) {
        continue; // re-read + re-merge onto the concurrent writer's version
      }
      throw err;
    }
  }
  // The bounded loop always returns on the final attempt (unconditional write).
  throw new Error("upsertStatusComment: exhausted retries without resolving");
}
