import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * In-place editing of `~/.agentmemory/.env`.
 *
 * 🔴 That file holds the API keys of every configured provider. Two rules bind
 * everything below:
 *   - its contents are NEVER printed, logged or put into an error string —
 *     diagnostics name KEYS and paths only, never values, not even on the
 *     failure branches;
 *   - a half-written `.env` is the worst outcome this module can produce, so
 *     the write goes to a temporary file in the same directory and lands with
 *     `renameSync` (atomic within a filesystem), after a timestamped backup.
 *
 * `enableInjectContextInEnv` (`src/cli/onboarding.ts:259-272`) is the shape
 * this follows, not the implementation: it only ever appends, which would
 * produce a second line for a key that already exists.
 */

export type EnvWriteResult =
  | { ok: true; changed: false }
  | {
      ok: true;
      changed: true;
      /** Backup of the previous file. `""` when the file did not exist yet. */
      backupPath: string;
      created: boolean;
      /**
       * How many lines were rewritten for keys that occur more than once
       * un-commented (0 when every key occurred at most once). The caller warns
       * with this number and never with the values.
       */
      duplicates: number;
    }
  | { ok: false; reason: string };

/** POSIX env var name. Also what keeps the per-key RegExp below injection-free. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function setEnvKeys(
  envPath: string,
  updates: Record<string, string>,
): EnvWriteResult {
  const keys = Object.keys(updates);
  if (keys.length === 0) return { ok: true, changed: false };
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      return { ok: false, reason: `invalid env key name: ${key}` };
    }
  }

  let existed = false;
  try {
    existed = existsSync(envPath);
    const original = existed ? readFileSync(envPath, "utf-8") : "";
    // Rule 7: keep whatever mode the operator's file already has; a file we
    // create ourselves is 0600 because the next line written into it is a
    // credential.
    const mode = existed ? statSync(envPath).mode & 0o777 : 0o600;

    const { text, duplicates } = applyUpdates(original, updates);

    // Rule 4: every requested value already stands as requested. Nothing is
    // rewritten, so no backup is taken and mtime does not move.
    if (existed && text === original) return { ok: true, changed: false };

    let backupPath = "";
    if (existed) {
      // Rule 5: backup BEFORE the write, same mode as the original.
      backupPath = pickBackupPath(envPath);
      copyFileSync(envPath, backupPath);
      chmodSync(backupPath, mode);
    }
    writeAtomically(envPath, text, mode);

    return { ok: true, changed: true, backupPath, created: !existed, duplicates };
  } catch (err) {
    // Deliberately assembled by hand: an fs error message would carry the path
    // (fine) but this keeps the shape fixed and content-free forever.
    const code =
      typeof (err as NodeJS.ErrnoException)?.code === "string"
        ? (err as NodeJS.ErrnoException).code
        : "unknown error";
    return {
      ok: false,
      reason: `could not update ${keys.join(", ")} in ${envPath}: ${code}`,
    };
  }
}

function applyUpdates(
  original: string,
  updates: Record<string, string>,
): { text: string; duplicates: number } {
  // Split on "\n" only, and join back the same way: every byte the update does
  // not touch — CRLF, blank lines, comments, order, a missing final newline —
  // survives unchanged (rule 6).
  const lines = original.split("\n");
  const missing: string[] = [];
  let duplicates = 0;

  for (const [key, value] of Object.entries(updates)) {
    // Rule 2: a commented-out line is NOT an occurrence — `# KEY=true` is the
    // sample shipped in .env.example, and `^\s*KEY\s*=` cannot match it because
    // of the leading `#`.
    const assignment = new RegExp(`^(\\s*${key}\\s*=)(.*)$`);
    let hits = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      const hasCr = raw.endsWith("\r");
      const line = hasCr ? raw.slice(0, -1) : raw;
      const match = line.match(assignment);
      if (!match) continue;
      hits++; // rule 3: keep counting, every occurrence gets rewritten
      const { lead, value: current, suffix } = splitValue(match[2] ?? "");
      if (current === value) continue; // already correct: line kept byte-exact
      lines[i] = `${match[1]}${lead}${formatValue(value)}${suffix}${hasCr ? "\r" : ""}`;
    }

    if (hits === 0) missing.push(key);
    if (hits > 1) duplicates += hits;
  }

  let text = lines.join("\n");
  if (missing.length > 0) {
    // Rule 2/9: absent key is appended at the end, with a newline in front when
    // the file does not end with one.
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    const appended = missing
      .map((key) => `${key}=${formatValue(updates[key] ?? "")}`)
      .join("\n");
    text = `${text}${prefix}${appended}\n`;
  }

  return { text, duplicates };
}

/**
 * Splits the right-hand side of an assignment into the value and whatever
 * trails it (an inline `# comment`), so that rewriting a value keeps the
 * comment and so that `KEY="true"` is recognised as already holding `true`
 * instead of being rewritten on every run.
 */
function splitValue(rest: string): { lead: string; value: string; suffix: string } {
  // Whitespace on both sides of the value is kept verbatim, so `KEY = x  # note`
  // keeps its spacing and its note when `x` is replaced.
  const lead = rest.slice(0, rest.length - rest.trimStart().length);
  const body = rest.slice(lead.length);
  const double = body.match(/^"((?:\\.|[^"\\])*)"/);
  if (double) return { lead, value: double[1] ?? "", suffix: body.slice(double[0].length) };
  const single = body.match(/^'([^']*)'/);
  if (single) return { lead, value: single[1] ?? "", suffix: body.slice(single[0].length) };
  const comment = body.search(/\s#/);
  const head = comment >= 0 ? body.slice(0, comment) : body;
  const value = head.trimEnd();
  return { lead, value, suffix: body.slice(value.length) };
}

/** Quotes only when the raw form would not read back as the same value. */
function formatValue(value: string): string {
  return value === "" || /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function pickBackupPath(envPath: string): string {
  // <envPath>.bak-YYYYMMDDTHHMMSS
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  let candidate = `${envPath}.bak-${stamp}`;
  for (let n = 2; existsSync(candidate) && n < 100; n++) {
    candidate = `${envPath}.bak-${stamp}-${n}`;
  }
  return candidate;
}

function writeAtomically(target: string, text: string, mode: number): void {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    // "wx" — never reuse a leftover temp file. fsync before rename, otherwise
    // the rename may land ahead of the data on a crash and truncate the file
    // that holds every provider's key.
    const fd = openSync(tmp, "wx", mode);
    try {
      writeFileSync(fd, text, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // umask can have masked bits out of the `open` mode; set the mode we mean.
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
    throw err;
  }
}
