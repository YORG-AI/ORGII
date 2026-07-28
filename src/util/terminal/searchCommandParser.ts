/**
 * Shell search-command classifier.
 *
 * Agent CLIs (Claude Code, Codex, …) frequently run their code searches
 * through the shell — `grep -rn "pattern" src --include="*.ts" | head -20` —
 * instead of a dedicated grep/search tool. Those events arrive as `run_shell`
 * and, without this module, render as opaque terminal commands.
 *
 * `parseShellSearchCommand` decides whether a shell command is *purely* a
 * code search — a grep-family invocation optionally piped through harmless
 * stream filters — and extracts the pattern/paths so the UI can render it
 * with the same treatment as a native grep tool event.
 *
 * Deliberately conservative: any compound command (`&&`, `;`, `||`, `&`),
 * unknown executable in the pipeline, or missing pattern disqualifies the
 * command and it stays a terminal event.
 */
import { scanCommand } from "./commandParser";

export interface ShellSearchCommand {
  /** The search executable anchoring the pipeline (`grep`, `rg`, `git grep`). */
  tool: string;
  /** Search pattern — from `-e`/`--regexp` or the first positional argument. */
  pattern: string;
  /** Positional search targets (files/directories) after the pattern. */
  paths: string[];
  /**
   * True when the output is a file list rather than `path:line:content` rows:
   * `-l` / `--files-with-matches`, or `rg --files`.
   */
  filesOnly: boolean;
}

/** Executables that make a pipeline a code search. */
const SEARCH_EXECUTABLES = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "ugrep",
]);

/**
 * Stream filters that keep a search pipeline a search: they only reshape the
 * match output. Anything else (`xargs`, `tee`, redirect-into-command tools)
 * disqualifies the command.
 */
const FILTER_EXECUTABLES = new Set([
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "cat",
  "sed",
  "awk",
  "column",
  "less",
]);

/**
 * Long flags (grep + rg merged) whose value is a separate token when written
 * without `=`. Over-matching is harmless here — the worst case is skipping a
 * path token, never mis-capturing the pattern.
 */
const VALUE_LONG_FLAGS = new Set([
  "--regexp",
  "--file",
  "--max-count",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--after-context",
  "--before-context",
  "--context",
  "--glob",
  "--iglob",
  "--type",
  "--type-not",
  "--max-depth",
  "--threads",
  "--encoding",
  "--sort",
  "--sortr",
  "--binary-files",
  "--devices",
  "--directories",
  "--label",
]);

/** Short flags (grep + rg) that consume the next token as their value. */
const VALUE_SHORT_FLAGS = new Set([
  "e",
  "f",
  "m",
  "A",
  "B",
  "C",
  "d",
  "D",
  "g",
  "t",
  "T",
  "j",
  "E",
]);

/** Cheap prefix gate so non-search commands bail before the full scan. */
const SEARCH_PREFIX_RE =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:grep|egrep|fgrep|zgrep|rg|ag|ack|ugrep|git)(?:\s|$)/;

/** `FOO=bar` leading environment assignment. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A token that is (the start of) a redirection: `>`, `>>`, `<`, `2>`, `2>&1`… */
const REDIRECT_ONLY_RE = /^\d*(?:>>?|<)$/;
const REDIRECT_COMBINED_RE = /^\d*(?:>>?|<)./;

/**
 * Split a single pipeline segment into shell words, honouring quotes and
 * backslash escapes. Quotes are stripped from the returned words; redirections
 * (and their targets) are dropped.
 */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (hasWord) tokens.push(word);
    word = "";
    hasWord = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else {
        word += ch;
        hasWord = true;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < segment.length) {
        word += segment[i + 1];
        hasWord = true;
        i++;
      } else {
        word += ch;
        hasWord = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      word += segment[i + 1];
      hasWord = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    word += ch;
    hasWord = true;
  }
  push();

  // Drop redirections. `> file` consumes the following token as its target;
  // `2>/dev/null` and `2>&1` are self-contained.
  const cleaned: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (REDIRECT_ONLY_RE.test(token)) {
      i++; // skip the redirect target
      continue;
    }
    if (REDIRECT_COMBINED_RE.test(token)) continue;
    cleaned.push(token);
  }
  return cleaned;
}

function basename(token: string): string {
  return token.split("/").pop() || token;
}

/** Words of a segment with leading `FOO=bar` assignments removed. */
function segmentWords(segment: string): string[] {
  const tokens = tokenizeSegment(segment);
  let start = 0;
  while (start < tokens.length && ASSIGNMENT_RE.test(tokens[start])) start++;
  return tokens.slice(start);
}

interface ParsedSearchInvocation {
  tool: string;
  pattern: string;
  paths: string[];
  filesOnly: boolean;
}

/** Parse the argument list of a grep-family invocation (executable removed). */
function parseSearchArgs(
  tool: string,
  args: string[]
): ParsedSearchInvocation | null {
  let pattern = "";
  let filesOnly = false;
  let rgFilesListing = false;
  let globValue = "";
  const paths: string[] = [];
  let positionalOnly = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const flag = eqIndex === -1 ? token : token.slice(0, eqIndex);
      const attached = eqIndex === -1 ? null : token.slice(eqIndex + 1);
      if (flag === "--files-with-matches") filesOnly = true;
      if (flag === "--files") rgFilesListing = true;
      const value =
        attached ??
        (VALUE_LONG_FLAGS.has(flag) && i + 1 < args.length ? args[++i] : null);
      if (value !== null) {
        if (flag === "--regexp" && !pattern) pattern = value;
        if (flag === "--glob" || flag === "--iglob") globValue = value;
      }
      continue;
    }

    if (!positionalOnly && token.startsWith("-") && token.length > 1) {
      // Short flag cluster, e.g. `-rn`, `-rln`, `-rne`. Only the trailing
      // letter of a cluster can take a separate value (`grep -rne pat`).
      const letters = token.slice(1);
      if (letters.includes("l")) filesOnly = true;
      const last = letters[letters.length - 1];
      if (VALUE_SHORT_FLAGS.has(last) && i + 1 < args.length) {
        const value = args[++i];
        if (last === "e" && !pattern) pattern = value;
        if (last === "g") globValue = value;
      }
      continue;
    }

    if (!pattern && !rgFilesListing) {
      pattern = token;
      continue;
    }
    paths.push(token);
  }

  if (rgFilesListing) {
    // `rg --files [-g glob]` — a file listing, not a match search. Surface it
    // as a files-only search over the glob (mirrors glob tool semantics).
    return { tool, pattern: globValue, paths, filesOnly: true };
  }

  if (!pattern) return null;
  return { tool, pattern, paths, filesOnly };
}

/**
 * Classify a shell command as a pure code-search pipeline.
 *
 * Returns `null` unless:
 * - every top-level operator is a plain pipe (`|`);
 * - the first pipeline segment invokes a grep-family executable
 *   (`git grep` included);
 * - every later segment is a known stream filter (or another grep);
 * - a search pattern could be extracted.
 */
export function parseShellSearchCommand(
  command: string | undefined
): ShellSearchCommand | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed || !SEARCH_PREFIX_RE.test(trimmed)) return null;

  const { operators } = scanCommand(command);
  for (const op of operators) {
    if (op.length !== 1 || command[op.index] !== "|") return null;
  }

  // Slice the raw command into pipeline segments at the top-level pipes.
  const segments: string[] = [];
  let cursor = 0;
  for (const op of operators) {
    segments.push(command.slice(cursor, op.index));
    cursor = op.index + op.length;
  }
  segments.push(command.slice(cursor));

  const firstWords = segmentWords(segments[0]);
  if (firstWords.length === 0) return null;

  let exe = basename(firstWords[0]);
  let argStart = 1;
  if (exe === "git" && firstWords[1] === "grep") {
    exe = "git grep";
    argStart = 2;
  }
  if (exe !== "git grep" && !SEARCH_EXECUTABLES.has(exe)) return null;

  for (const segment of segments.slice(1)) {
    const words = segmentWords(segment);
    if (words.length === 0) return null;
    const filterExe = basename(words[0]);
    if (
      !FILTER_EXECUTABLES.has(filterExe) &&
      !SEARCH_EXECUTABLES.has(filterExe)
    ) {
      return null;
    }
  }

  return parseSearchArgs(exe, firstWords.slice(argStart));
}

/** Convenience boolean wrapper around {@link parseShellSearchCommand}. */
export function isShellSearchCommand(command: string | undefined): boolean {
  return parseShellSearchCommand(command) !== null;
}
