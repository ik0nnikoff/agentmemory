import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexTomlSettings = { model?: string; reasoningEffort?: string };

/**
 * Reads `model` and `model_reasoning_effort` out of the operator's own
 * `<codexHome>/config.toml`.
 *
 * 🔴 READ ONLY. The file belongs to Codex and to the operator; nothing in
 * agentmemory ever writes to it. Our own overrides live in
 * `~/.agentmemory/.env` (see `env-file.ts`).
 *
 * The parser is deliberately minimal instead of pulling in a TOML dependency:
 * only the top-level keys matter, so it reads lines up to the first `[section]`
 * header, drops `#` comments, and unquotes the value. A key that is not there
 * is not an error — it means "Codex decides", which is a state the caller must
 * show as such rather than substituting an invented model name.
 */
export function readCodexToml(codexHome: string): CodexTomlSettings {
  let text: string;
  try {
    text = readFileSync(join(codexHome, "config.toml"), "utf-8");
  } catch {
    return {};
  }

  const settings: CodexTomlSettings = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Everything from the first table header on belongs to that table, not to
    // the top level, so `[profiles.x] model = "…"` must not be picked up here.
    if (line.startsWith("[")) break;
    if (line === "" || line.startsWith("#")) continue;

    const match = line.match(/^(model|model_reasoning_effort)\s*=\s*(.+)$/);
    if (!match) continue;
    const value = unquote(match[2] ?? "");
    if (value === "") continue;
    if (match[1] === "model") settings.model = value;
    else settings.reasoningEffort = value;
  }
  return settings;
}

function unquote(rest: string): string {
  const double = rest.match(/^"((?:\\.|[^"\\])*)"/);
  if (double) return double[1] ?? "";
  const single = rest.match(/^'([^']*)'/);
  if (single) return single[1] ?? "";
  const comment = rest.search(/\s#/);
  return (comment >= 0 ? rest.slice(0, comment) : rest).trim();
}
