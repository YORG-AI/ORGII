import { describe, expect, it } from "vitest";

import { getCommandSymbolList } from "../TerminalBlock/commandParser";

describe("getCommandSymbolList", () => {
  it("extracts the executable of each piped sub-command", () => {
    expect(getCommandSymbolList("git status --short | grep foo")).toEqual([
      "git",
      "grep",
    ]);
  });

  it("does not treat `2>&1` as a background operator", () => {
    // Regression: the `&` in `2>&1` split the sub-command and captured the
    // trailing `1` as a bogus executable → ['git', '1', 'tail'].
    expect(
      getCommandSymbolList('git commit -F "/tmp/msg.txt" 2>&1 | tail -25')
    ).toEqual(["git", "tail"]);
  });

  it("ignores fd redirections `>&`, `&>`, `&>>`", () => {
    expect(getCommandSymbolList("make build &>build.log")).toEqual(["make"]);
    expect(getCommandSymbolList("foo >&2")).toEqual(["foo"]);
    expect(getCommandSymbolList("python train.py > out.log 2>&1")).toEqual([
      "python",
    ]);
  });

  it("still splits on a real backgrounding `&`", () => {
    expect(getCommandSymbolList("server start &")).toEqual(["server"]);
    expect(getCommandSymbolList("build & serve")).toEqual(["build", "serve"]);
  });

  it("skips prose inside heredoc bodies", () => {
    // `go`, `echo` inside the heredoc body must not be surfaced as commands.
    expect(
      getCommandSymbolList("cat > msg.txt <<'EOF'\ngo run this echo that\nEOF")
    ).toEqual(["cat"]);
  });
});
