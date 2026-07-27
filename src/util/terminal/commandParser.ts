/**
 * Shell command parser — shared by the TerminalBlock header chip and the
 * Code Editor replay command sidebar.
 *
 * Pure module — no React, no DOM, no atoms — so it can be unit-tested in
 * isolation. Three helpers are exported:
 *
 *   - `getCommandSymbolList` — extracts the executable invoked by each
 *     sub-command, skipping prose inside quoted strings and heredoc bodies.
 *     Used to label a command with "what tool is this?", e.g. `python3`,
 *     `npm`, `git`.
 *   - `formatCommandForDisplay` — light pretty-printer that adds a newline
 *     before each top-level shell operator so long compound commands wrap
 *     at logical boundaries when rendered in the terminal body.
 *   - `truncateCommandPreview` — caps the rendered command at the earlier of
 *     a line limit or character limit and marks truncated content with `...`.
 *
 * Both the symbol list and the pretty-printer run off one scanner
 * (`scanCommand`) so an operator that is *inside* a quoted argument — the
 * `\|` alternations in `grep -rn "FOO\|\[bar\]" src/`, say — never counts as
 * a sub-command boundary in either place.
 */

/** Max executables surfaced in a command label. */
const MAX_SYMBOLS = 5;

/** `FOO=bar cmd …` — the leading word is an assignment, not the executable. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Shell syntax that sits in command position without being a command. The
 * *next* word is still the executable: `if grep …`, `do echo …`.
 */
const TRANSPARENT_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "esac",
  "in",
  "function",
  "coproc",
  "!",
  "{",
  "}",
]);

/**
 * Keywords whose clause is a name / test expression rather than a command —
 * `for f in *.ts`, `[ -f x ]`. Nothing until the next `;` is an executable.
 */
const CLAUSE_KEYWORDS = new Set(["for", "select", "case", "[", "[["]);

/**
 * Commands that run another command: worth surfacing themselves, but the word
 * after them (past its flags) is the tool the user actually cares about.
 */
const WRAPPER_COMMANDS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "timeout",
  "nice",
  "ionice",
  "stdbuf",
  "xargs",
]);

interface Frame {
  /**
   * Char that closes this scope: `)` for `$(…)` and `(…)`, a backtick for
   * `` `…` ``. The root frame closes at end-of-input and uses `null`.
   */
  closer: ")" | "`" | null;
  quote: '"' | "'" | null;
  /** The next word is the executable of a (sub-)command. */
  atCommandPosition: boolean;
  word: string;
  wordHasContent: boolean;
  /** Word contains an expansion — `$(…)`, `${…}` — so its text can't name the executable. */
  wordIsDynamic: boolean;
  /** A redirection operator was just consumed; the next word is its target. */
  pendingRedirectTarget: boolean;
}

interface OperatorSpan {
  index: number;
  length: number;
}

interface CommandScan {
  /** First token of each sub-command, in order, un-deduped. */
  executables: string[];
  /** Offsets of the top-level `&&` / `||` / `|` / `;` / `&` operators. */
  operators: OperatorSpan[];
}

function createFrame(
  closer: Frame["closer"],
  atCommandPosition: boolean
): Frame {
  return {
    closer,
    quote: null,
    atCommandPosition,
    word: "",
    wordHasContent: false,
    wordIsDynamic: false,
    pendingRedirectTarget: false,
  };
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
 * Walk `commandText` once, tracking quote / expansion / heredoc state, and
 * report both the executable of each sub-command and where the top-level
 * operators sit.
 *
 * Sub-commands are split on top-level `;`, `&`, `&&`, `||`, `|`. Everything
 * inside `'…'`, `"…"`, `<<EOF … EOF`, `$(…)`, `` `…` ``, `${…}` and `$((…))`
 * is scoped: a `|` in there belongs to that scope, not to the outer command.
 * Command substitutions are still descended into — `f=$(ls -t | head -1)`
 * really does run `ls` and `head`, and those are the useful labels.
 */
function scanCommand(commandText: string): CommandScan {
  const executables: string[] = [];
  const operators: OperatorSpan[] = [];
  const stack: Frame[] = [createFrame(null, true)];
  let heredocTerminator: string | null = null;
  let inHeredocBody = false;

  const resetWord = (frame: Frame) => {
    frame.word = "";
    frame.wordHasContent = false;
    frame.wordIsDynamic = false;
  };

  const endWord = (frame: Frame) => {
    if (frame.pendingRedirectTarget) {
      // `> out.log` — the target is a file, never the executable.
      frame.pendingRedirectTarget = false;
      resetWord(frame);
      return;
    }
    if (frame.atCommandPosition && frame.wordHasContent) {
      const word = frame.word;
      if (CLAUSE_KEYWORDS.has(word)) {
        // `for f in *.ts`, `[ -f x ]` — names and test operands, not commands.
        frame.atCommandPosition = false;
      } else if (
        TRANSPARENT_KEYWORDS.has(word) ||
        ASSIGNMENT_PREFIX.test(word) ||
        // A flag or a bare number in command position belongs to a wrapper we
        // just passed through (`sudo -u www npm …`, `timeout 30 npm …`).
        /^[-+]/.test(word) ||
        /^\d+$/.test(word)
      ) {
        // Keep looking: the executable is a later word in this sub-command.
      } else if (frame.wordIsDynamic) {
        // `$(which python) --version` — the substitution's own executable was
        // captured while descending into it; the outer word can't be named.
        frame.atCommandPosition = false;
      } else {
        const exe = cleanExecutableToken(frame.word);
        if (exe) {
          executables.push(exe);
          // `sudo apt …` — surface the wrapper *and* what it wraps.
          frame.atCommandPosition = WRAPPER_COMMANDS.has(exe.toLowerCase());
        }
        // A word that cleans away to nothing (`(`) is punctuation, not an
        // executable — stay in command position for the real one.
      }
    }
    resetWord(frame);
  };

  const startSubCommand = (frame: Frame) => {
    endWord(frame);
    frame.atCommandPosition = true;
  };

  const appendChar = (frame: Frame, ch: string) => {
    if (frame.atCommandPosition) frame.word += ch;
    frame.wordHasContent = true;
  };

  const recordOperator = (index: number, length: number) => {
    if (stack.length === 1) operators.push({ index, length });
  };

  /** `${…}` / `$((…))` — opaque to us; skip to the matching close. */
  const skipBalanced = (
    line: string,
    start: number,
    open: string,
    close: string
  ): number => {
    let depth = 0;
    for (let i = start; i < line.length; i++) {
      if (line[i] === open) depth++;
      else if (line[i] === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return line.length - 1;
  };

  const lines = commandText.split("\n");
  let lineStart = 0;

  for (const line of lines) {
    const currentLineStart = lineStart;
    lineStart += line.length + 1;

    if (inHeredocBody) {
      if (heredocTerminator !== null && line.trim() === heredocTerminator) {
        inHeredocBody = false;
        heredocTerminator = null;
      }
      continue;
    }

    for (let i = 0; i < line.length; i++) {
      const frame = stack[stack.length - 1];
      const ch = line[i];

      if (frame.quote === "'") {
        if (ch === "'") frame.quote = null;
        appendChar(frame, ch);
        continue;
      }

      // Inside `"…"` most characters are literal, but `\`, `$(`, `${` and
      // backticks keep their meaning — a substitution there is a real command.
      if (frame.quote === '"') {
        if (ch === "\\" && i + 1 < line.length) {
          appendChar(frame, line[i + 1]);
          i++;
          continue;
        }
        if (ch === '"') {
          frame.quote = null;
          appendChar(frame, ch);
          continue;
        }
        if (ch === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
          i = skipBalanced(line, i + 1, "(", ")");
          frame.wordIsDynamic = true;
          frame.wordHasContent = true;
          continue;
        }
        if (ch === "$" && line[i + 1] === "(") {
          frame.wordIsDynamic = true;
          frame.wordHasContent = true;
          stack.push(createFrame(")", true));
          i++;
          continue;
        }
        if (ch === "$" && line[i + 1] === "{") {
          i = skipBalanced(line, i + 1, "{", "}");
          frame.wordIsDynamic = true;
          frame.wordHasContent = true;
          continue;
        }
        appendChar(frame, ch);
        continue;
      }

      // --- unquoted ---

      if (ch === "\\") {
        if (i + 1 < line.length) {
          // `grep foo\|bar` — the escaped operator is part of the argument.
          appendChar(frame, line[i + 1]);
          i++;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        frame.quote = ch;
        appendChar(frame, ch);
        continue;
      }

      // Closing an expansion / subshell scope. Checked before the openers so
      // the trailing backtick of `` `date` `` closes rather than re-opens.
      if (frame.closer !== null && ch === frame.closer) {
        endWord(frame);
        stack.pop();
        continue;
      }

      if (ch === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
        i = skipBalanced(line, i + 1, "(", ")");
        frame.wordIsDynamic = true;
        frame.wordHasContent = true;
        continue;
      }
      if (ch === "$" && line[i + 1] === "(") {
        frame.wordIsDynamic = true;
        frame.wordHasContent = true;
        stack.push(createFrame(")", true));
        i++;
        continue;
      }
      if (ch === "$" && line[i + 1] === "{") {
        i = skipBalanced(line, i + 1, "{", "}");
        frame.wordIsDynamic = true;
        frame.wordHasContent = true;
        continue;
      }
      if (ch === "`") {
        frame.wordIsDynamic = true;
        frame.wordHasContent = true;
        stack.push(createFrame("`", true));
        continue;
      }

      // `(cmd …)` subshell — only at command position, so `foo(bar)` in an
      // argument stays an argument.
      if (ch === "(" && frame.atCommandPosition && !frame.wordHasContent) {
        stack.push(createFrame(")", true));
        continue;
      }

      // Heredoc start: `<<` optionally followed by `-`, then a delimiter
      // (possibly quoted). The body begins on the next line.
      if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
        let j = i + 2;
        if (line[j] === "-") j++;
        // Skip whitespace between `<<` and delimiter (rare but legal).
        while (j < line.length && line[j] === " ") j++;
        const rest = line.slice(j);
        const delimMatch = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest);
        if (delimMatch) {
          heredocTerminator = delimMatch[2];
          inHeredocBody = true;
          // Skip past the delimiter; the remainder of this line still
          // belongs to the opening sub-command.
          i = j + delimMatch[0].length - 1;
          continue;
        }
      }

      // Redirections. `2>file`, `>out.log`, `<input`, `<<<"here string"` —
      // the fd prefix and the target are neither operators nor executables.
      if (ch === ">" || ch === "<") {
        if (/^\d*$/.test(frame.word)) resetWord(frame);
        else endWord(frame);
        frame.pendingRedirectTarget = true;
        if (line[i + 1] === ">" || line[i + 1] === "<") i++;
        continue;
      }

      if (/\s/.test(ch)) {
        // Whitespace between a redirection and its target must not consume
        // the pending flag — `> out.log` still has to discard `out.log`.
        if (frame.wordHasContent) endWord(frame);
        continue;
      }

      // `;;` ends a `case` arm — one operator, not two.
      if (ch === ";" && line[i + 1] === ";") {
        recordOperator(currentLineStart + i, 2);
        startSubCommand(frame);
        i++;
        continue;
      }
      if (ch === ";") {
        recordOperator(currentLineStart + i, 1);
        startSubCommand(frame);
        continue;
      }
      // An unmatched `)` closes a `case` pattern (`start) npm run dev;;`);
      // the arm body that follows is a command list.
      if (ch === ")" && frame.closer === null) {
        startSubCommand(frame);
        continue;
      }
      if (ch === "&" && line[i + 1] === "&") {
        recordOperator(currentLineStart + i, 2);
        startSubCommand(frame);
        i++;
        continue;
      }
      if (ch === "|" && line[i + 1] === "|") {
        recordOperator(currentLineStart + i, 2);
        startSubCommand(frame);
        i++;
        continue;
      }
      if (ch === "|") {
        recordOperator(currentLineStart + i, 1);
        startSubCommand(frame);
        continue;
      }
      if (ch === "&") {
        // A bare `&` backgrounds a job, but `&` also appears inside
        // redirections (`2>&1`, `>&2`, `&>file`, `&>>file`) where it must NOT
        // start a new sub-command — otherwise the digit after it (e.g. the
        // `1` in `2>&1`) is mis-captured as an executable.
        if (frame.pendingRedirectTarget || line[i + 1] === ">") {
          appendChar(frame, ch);
          continue;
        }
        recordOperator(currentLineStart + i, 1);
        startSubCommand(frame);
        continue;
      }

      appendChar(frame, ch);
    }

    // A newline outside a heredoc terminates the current word but stays
    // inside the same sub-command (think a backslash-less wrapped line).
    const lineEndFrame = stack[stack.length - 1];
    if (lineEndFrame.wordHasContent) endWord(lineEndFrame);
  }

  const finalFrame = stack[stack.length - 1];
  if (finalFrame.wordHasContent) endWord(finalFrame);

  return { executables, operators };
}

/**
 * Command symbols beside the title — the executables being invoked,
 * surfaced verbatim from each sub-command (de-duped, capped at
 * `MAX_SYMBOLS`). No allow-list: if the user runs `tsx scripts/foo.ts`, we
 * surface `tsx` even though it isn't a tool we'd think to enumerate. This is
 * much more accurate than scanning every whitespace-separated token for known
 * names, which mis-detected prose inside heredocs / quoted strings (e.g. the
 * word "go" in a python doc-string).
 */
export function getCommandSymbolList(
  commandText: string | undefined
): string[] {
  if (!commandText?.trim()) return [];
  const { executables } = scanCommand(commandText);
  // Drop leftovers that aren't really "the tool being run": assignment
  // fragments, flags, and bare fd numbers.
  const interesting = executables.filter(
    (token) =>
      token.length > 0 &&
      !token.includes("=") &&
      !/^[-+]/.test(token) &&
      !/^\d+$/.test(token)
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of interesting) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
    if (result.length >= MAX_SYMBOLS) break;
  }
  return result;
}

/**
 * Insert newlines before top-level shell operators so compound commands wrap
 * at logical boundaries. Operators inside quotes, heredocs and substitutions
 * are left alone — breaking there would rewrite the argument the user sees.
 */
export function formatCommandForDisplay(raw: string): string {
  const { operators } = scanCommand(raw);
  if (operators.length === 0) return raw;

  let result = "";
  let cursor = 0;
  for (const { index } of operators) {
    if (index < cursor) continue;
    let breakAt = index;
    while (
      breakAt > cursor &&
      (raw[breakAt - 1] === " " || raw[breakAt - 1] === "\t")
    ) {
      breakAt--;
    }
    result += raw.slice(cursor, breakAt);
    if (breakAt > 0 && raw[breakAt - 1] !== "\n") result += "\n";
    cursor = index;
  }
  result += raw.slice(cursor);
  return result;
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
