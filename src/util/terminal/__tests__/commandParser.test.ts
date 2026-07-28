import { describe, expect, it } from "vitest";

import {
  formatCommandForDisplay,
  getCommandSymbolList,
  truncateCommandPreview,
} from "../commandParser";

describe("truncateCommandPreview", () => {
  it("keeps short commands unchanged", () => {
    expect(truncateCommandPreview("npm test")).toBe("npm test");
  });

  it("truncates after four lines", () => {
    expect(truncateCommandPreview("one\ntwo\nthree\nfour\nfive")).toBe(
      "one\ntwo\nthree\nfour..."
    );
  });

  it("truncates at 200 characters when that limit comes first", () => {
    const command = "x".repeat(201);
    expect(truncateCommandPreview(command)).toBe(`${"x".repeat(200)}...`);
  });
});

describe("formatCommandForDisplay", () => {
  it("wraps before top-level operators", () => {
    expect(formatCommandForDisplay("cd src && npm test | tee log")).toBe(
      "cd src\n&& npm test\n| tee log"
    );
  });

  it("leaves operators inside quoted arguments alone", () => {
    const command = 'grep -rn "foo\\|bar" src/ | head -20';
    expect(formatCommandForDisplay(command)).toBe(
      'grep -rn "foo\\|bar" src/\n| head -20'
    );
  });

  it("returns commands without top-level operators unchanged", () => {
    expect(formatCommandForDisplay('echo "a | b; c"')).toBe('echo "a | b; c"');
  });
});

describe("getCommandSymbolList", () => {
  it("returns the executable of a simple command", () => {
    expect(getCommandSymbolList("npm install")).toEqual(["npm"]);
  });

  it("returns nothing for an empty / whitespace-only command", () => {
    expect(getCommandSymbolList("")).toEqual([]);
    expect(getCommandSymbolList("   ")).toEqual([]);
    expect(getCommandSymbolList(undefined)).toEqual([]);
  });

  it("splits on shell operators and yields first token of each sub-command", () => {
    expect(getCommandSymbolList("cd src && npm install")).toEqual([
      "cd",
      "npm",
    ]);
    expect(getCommandSymbolList("git status; git diff")).toEqual(["git"]);
    expect(getCommandSymbolList("cat foo.txt | grep bar | wc -l")).toEqual([
      "cat",
      "grep",
      "wc",
    ]);
    expect(getCommandSymbolList("make build || echo failed")).toEqual([
      "make",
      "echo",
    ]);
  });

  it("extracts the executable of each piped sub-command", () => {
    expect(getCommandSymbolList("git status --short | grep foo")).toEqual([
      "git",
      "grep",
    ]);
  });

  it("ignores prose inside double and single quotes", () => {
    expect(getCommandSymbolList('echo "let us go and cd into /tmp"')).toEqual([
      "echo",
    ]);
    expect(getCommandSymbolList("echo 'go && cd'")).toEqual(["echo"]);
  });

  it("ignores shell operators inside quoted arguments", () => {
    // Regression: a quote-blind split on `|` shredded the grep pattern and
    // labelled the command `grep, \[|→\]", head`.
    expect(
      getCommandSymbolList('grep -rn "LINE_PREFIX\\|\\[|→\\]" src/ | head -20')
    ).toEqual(["grep", "head"]);
    expect(getCommandSymbolList("awk -F';' '{print $1}' data.csv")).toEqual([
      "awk",
    ]);
  });

  it("ignores shell operators escaped outside quotes", () => {
    expect(getCommandSymbolList("grep -rn foo\\|bar src/")).toEqual(["grep"]);
  });

  it("descends into command substitutions", () => {
    // `f=$(ls -t … | head -1)` used to lex as `f=$(ls`, `head`; the commands
    // actually being run are the useful label.
    expect(
      getCommandSymbolList("cd /tmp && f=$(ls -t logs | head -1) && cat $f")
    ).toEqual(["cd", "ls", "head", "cat"]);
    expect(getCommandSymbolList("echo `date`")).toEqual(["echo", "date"]);
    // The substitution supplies the executable, so its own command is the
    // only thing we can name.
    expect(getCommandSymbolList("$(which python3) --version")).toEqual([
      "which",
    ]);
  });

  it("does not treat parameter or arithmetic expansion as a command", () => {
    expect(getCommandSymbolList("echo ${HOME}/bin")).toEqual(["echo"]);
    expect(getCommandSymbolList("echo $((1 + 2))")).toEqual(["echo"]);
  });

  it("ignores heredoc bodies even when they contain command-like words", () => {
    const cmd = [
      "python3 - <<'PY'",
      "from pathlib import Path",
      "content = '''# How the Hash Edit System Actually works",
      "you can go to /tmp and cd into the directory",
      "'''",
      "PY",
    ].join("\n");
    expect(getCommandSymbolList(cmd)).toEqual(["python3"]);
  });

  it("handles heredoc with `-` indentation and unquoted delimiter", () => {
    const cmd = ["cat <<-EOF", "go here, cd there", "EOF"].join("\n");
    expect(getCommandSymbolList(cmd)).toEqual(["cat"]);
  });

  it("skips prose in a heredoc opened alongside a redirection", () => {
    expect(
      getCommandSymbolList("cat > msg.txt <<'EOF'\ngo run this echo that\nEOF")
    ).toEqual(["cat"]);
  });

  it("strips path prefix and outer punctuation from the executable", () => {
    expect(getCommandSymbolList("/usr/bin/python3 script.py")).toEqual([
      "python3",
    ]);
    expect(getCommandSymbolList("./scripts/run.sh")).toEqual(["run.sh"]);
  });

  it("looks inside a subshell for the executable", () => {
    expect(getCommandSymbolList("(cd src && make build)")).toEqual([
      "cd",
      "make",
    ]);
  });

  it("skips shell keywords and surfaces the commands they wrap", () => {
    expect(getCommandSymbolList("for f in *.ts; do echo $f; done")).toEqual([
      "echo",
    ]);
    expect(
      getCommandSymbolList(
        "if [ -f package.json ]; then npm ci; else echo missing; fi"
      )
    ).toEqual(["npm", "echo"]);
    expect(
      getCommandSymbolList("while read line; do printf '%s' $line; done < file")
    ).toEqual(["read", "printf"]);
    expect(
      getCommandSymbolList("case $1 in start) npm run dev;; esac")
    ).toEqual(["npm"]);
  });

  it("surfaces both a wrapper and the command it runs", () => {
    expect(getCommandSymbolList("sudo apt install -y ripgrep")).toEqual([
      "sudo",
      "apt",
    ]);
    expect(getCommandSymbolList("timeout 30 npm test -- --run")).toEqual([
      "timeout",
      "npm",
    ]);
    expect(
      getCommandSymbolList('find . -name "*.ts" | xargs -I{} tail -5 {}')
    ).toEqual(["find", "xargs", "tail"]);
  });

  it("skips env-var prefixes (FOO=bar cmd …) and surfaces the real command", () => {
    expect(getCommandSymbolList("FOO=bar npm test")).toEqual(["npm"]);
    expect(getCommandSymbolList("DEBUG=1 NODE_ENV=test node app.js")).toEqual([
      "node",
    ]);
  });

  it("does not treat redirection targets as executables", () => {
    expect(getCommandSymbolList("python train.py > out.log 2>&1")).toEqual([
      "python",
    ]);
    expect(getCommandSymbolList("make build &>build.log")).toEqual(["make"]);
    expect(getCommandSymbolList("foo >&2")).toEqual(["foo"]);
    expect(
      getCommandSymbolList('git commit -F "/tmp/msg.txt" 2>&1 | tail -25')
    ).toEqual(["git", "tail"]);
  });

  it("dedupes repeated executables across sub-commands and caps at 5", () => {
    expect(getCommandSymbolList("git add . && git commit && git push")).toEqual(
      ["git"]
    );
    expect(
      getCommandSymbolList("a && b && c && d && e && f && g && h")
    ).toHaveLength(5);
  });

  it("does not treat `&` after `&&` as a separate operator", () => {
    expect(getCommandSymbolList("npm run dev && cargo build")).toEqual([
      "npm",
      "cargo",
    ]);
  });

  it("treats a single `&` (background) as a sub-command boundary", () => {
    expect(getCommandSymbolList("sleep 100 & echo done")).toEqual([
      "sleep",
      "echo",
    ]);
    expect(getCommandSymbolList("server start &")).toEqual(["server"]);
    expect(getCommandSymbolList("build & serve")).toEqual(["build", "serve"]);
  });
});
