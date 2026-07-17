/**
 * Shell command parser for the TerminalBlock header chip.
 *
 * Pure module — no React, no DOM, no atoms — so it can be unit-tested in
 * isolation. Two helpers are exported:
 *
 *   - `formatCommandForDisplay` — light pretty-printer that adds a newline
 *     before each top-level shell operator so long compound commands wrap
 *     at logical boundaries when rendered in the terminal body.
 *   - `truncateCommandPreview` — caps the rendered command at the earlier of
 *     a line limit or character limit and marks truncated content with `...`.
 *
 *   - `getCommandSymbolList` — extracts the executable being invoked by
 *     each sub-command, skipping prose inside quoted strings and heredoc
 *     bodies. Used to render a "what tool is this?" chip next to the
 *     header title, e.g. `python3`, `npm`, `git`.
 */

/** Insert newlines before shell operators so compound commands wrap at logical boundaries. */
export function formatCommandForDisplay(raw: string): string {
  return raw.replace(/ (&&|\|\||(?<![&])[&](?![&])|[|;]) /g, "\n$1 ");
}

/** Return a compact command preview, truncating at whichever limit is reached first. */
export function truncateCommandPreview(
  command: string,
  maxLines = 4,
  maxChars = 200
): string {
  const lines = command.split("\n");
  const lineLimited = lines.slice(0, maxLines).join("\n");
  const preview = lineLimited.slice(0, maxChars);
  const wasTruncated = lines.length > maxLines || lineLimited.length > maxChars;

  return wasTruncated ? `${preview.trimEnd()}...` : preview;
}

/** Strip outer punctuation/quotes from a bare token so `(npm)` / `./npm` / `` `git` `` all reduce to the executable basename. */
function cleanExecutableToken(token: string): string {
  let cleaned = token.replace(/^[`"']|[`"']$/g, "");
  cleaned = cleaned.replace(/^[\s$]+/, "");
  let previous = "";
  while (previous !== cleaned) {
    previous = cleaned;
    cleaned = cleaned.replace(/^[([{]+/, "");
    cleaned = cleaned.replace(/[)}\]]+$/, "");
  }
  const base = cleaned.split("/").pop() || cleaned;
  return base;
}

/**
 * Yield the first token of each shell sub-command in `commandText` — i.e.
 * the actual executable being invoked. This walks the string once,
 * tracking quote / heredoc state so we don't mistake prose inside a
 * `"..."`, `'...'`, `` `...` ``, or `<<'EOF' ... EOF` block for a command.
 *
 * Sub-commands are split on top-level `;`, `&`, `&&`, `||`, `|`.
 */
function extractSubCommandExecutables(commandText: string): string[] {
  const executables: string[] = [];
  let currentToken = "";
  let sawNonWhitespace = false;
  let expectingExecutable = true;
  let quote: '"' | "'" | "`" | null = null;
  let heredocTerminator: string | null = null;
  // When `inHeredocBody`, we consume lines until a line equals the
  // terminator. The opening `<<DELIM` (with optional `-` and quotes) is
  // detected on-the-fly below.
  let inHeredocBody = false;

  const flushToken = () => {
    if (expectingExecutable && currentToken) {
      const exe = cleanExecutableToken(currentToken);
      // `FOO=bar cmd ...` — the env-var prefix isn't the executable;
      // keep `expectingExecutable` true so we capture `cmd` next.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(exe)) {
        currentToken = "";
        sawNonWhitespace = false;
        return;
      }
      if (exe) executables.push(exe);
    }
    currentToken = "";
    sawNonWhitespace = false;
    expectingExecutable = false;
  };

  const startNewSubCommand = () => {
    flushToken();
    expectingExecutable = true;
  };

  const lines = commandText.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    if (inHeredocBody) {
      if (heredocTerminator !== null && line.trim() === heredocTerminator) {
        inHeredocBody = false;
        heredocTerminator = null;
      }
      continue;
    }

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (quote) {
        if (ch === quote) quote = null;
        if (expectingExecutable) currentToken += ch;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        if (expectingExecutable) currentToken += ch;
        continue;
      }

      // Detect heredoc start: `<<` optionally followed by `-`, then a
      // delimiter (possibly quoted). The body begins on the next line.
      if (ch === "<" && line[i + 1] === "<") {
        let j = i + 2;
        if (line[j] === "-") j++;
        // Skip whitespace between `<<` and delimiter (rare but legal).
        while (j < line.length && line[j] === " ") j++;
        const rest = line.slice(j);
        const delimMatch = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest);
        if (delimMatch) {
          heredocTerminator = delimMatch[2];
          inHeredocBody = true;
          // Skip past the delimiter on the opening line; remainder of
          // this line still belongs to the opening sub-command.
          i = j + delimMatch[0].length - 1;
          continue;
        }
      }

      if (/\s/.test(ch)) {
        if (sawNonWhitespace) flushToken();
        continue;
      }

      // Top-level operators that start a new sub-command.
      if (ch === ";") {
        startNewSubCommand();
        continue;
      }
      if (ch === "&" && line[i + 1] === "&") {
        startNewSubCommand();
        i++;
        continue;
      }
      if (ch === "|" && line[i + 1] === "|") {
        startNewSubCommand();
        i++;
        continue;
      }
      if (ch === "|") {
        startNewSubCommand();
        continue;
      }
      if (ch === "&") {
        // A bare `&` backgrounds a job, but `&` also appears inside
        // redirections (`2>&1`, `>&2`, `&>file`, `&>>file`) where it must
        // NOT start a new sub-command — otherwise the digit after it (e.g.
        // the `1` in `2>&1`) is mis-captured as an executable.
        const prev = line[i - 1];
        const next = line[i + 1];
        const isRedirection = prev === ">" || next === ">";
        if (isRedirection) {
          if (expectingExecutable) currentToken += ch;
          sawNonWhitespace = true;
          continue;
        }
        startNewSubCommand();
        continue;
      }

      if (expectingExecutable) currentToken += ch;
      sawNonWhitespace = true;
    }

    // Newline outside a heredoc terminates the current token but stays
    // inside the same sub-command (think a backslash-less wrapped line).
    if (sawNonWhitespace) flushToken();

    if (inHeredocBody && heredocTerminator === null) {
      // Defensive: malformed opener — bail.
      inHeredocBody = false;
    }
  }

  // Flush trailing token on the final line.
  if (sawNonWhitespace) flushToken();

  return executables;
}

/**
 * Command symbols beside the title — the executables being invoked,
 * surfaced verbatim from each sub-command (de-duped, capped at 5). No
 * allow-list: if the user runs `tsx scripts/foo.ts`, we surface `tsx`
 * even though it isn't a tool we'd think to enumerate. This is much
 * more accurate than scanning every whitespace-separated token for
 * known names, which mis-detected prose inside heredocs / quoted
 * strings (e.g. the word "go" in a python doc-string).
 */
export function getCommandSymbolList(
  commandText: string | undefined
): string[] {
  if (!commandText?.trim()) return [];
  const executables = extractSubCommandExecutables(commandText);
  // Filter out shell builtins / env-var assignments that aren't really
  // "the tool being run": `FOO=bar cmd ...` lexes `FOO=bar` as the first
  // token, but the user cares about `cmd`.
  const interesting = executables.filter(
    (token) =>
      token.length > 0 &&
      !token.includes("=") && // env-var prefix like FOO=bar
      !/^[-+]/.test(token) // leftover flag fragment
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of interesting) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
    if (result.length >= 5) break;
  }
  return result;
}
