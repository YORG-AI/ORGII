import { describe, expect, it } from "vitest";

import { getCommandSymbolList, truncateCommandPreview } from "../commandParser";

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

  it("ignores prose inside double, single, and backtick quotes", () => {
    expect(getCommandSymbolList('echo "let us go and cd into /tmp"')).toEqual([
      "echo",
    ]);
    expect(getCommandSymbolList("echo 'go && cd'")).toEqual(["echo"]);
    expect(getCommandSymbolList("echo `date`")).toEqual(["echo"]);
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

  it("strips path prefix and outer punctuation from the executable", () => {
    expect(getCommandSymbolList("/usr/bin/python3 script.py")).toEqual([
      "python3",
    ]);
    expect(getCommandSymbolList("./scripts/run.sh")).toEqual(["run.sh"]);
  });

  it("skips env-var prefixes (FOO=bar cmd …) and surfaces the real command", () => {
    expect(getCommandSymbolList("FOO=bar npm test")).toEqual(["npm"]);
    expect(getCommandSymbolList("DEBUG=1 NODE_ENV=test node app.js")).toEqual([
      "node",
    ]);
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
  });
});
