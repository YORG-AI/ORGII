/**
 * Tests for the shell search-command classifier.
 *
 * A command classifies only when it is a *pure* search pipeline: a
 * grep-family invocation, optionally piped through harmless stream filters.
 */
import { describe, expect, it } from "vitest";

import {
  isShellSearchCommand,
  parseShellSearchCommand,
} from "../searchCommandParser";

describe("parseShellSearchCommand", () => {
  it("classifies a plain recursive grep", () => {
    const parsed = parseShellSearchCommand('grep -rn "handleClick" src');
    expect(parsed).toEqual({
      tool: "grep",
      pattern: "handleClick",
      paths: ["src"],
      filesOnly: false,
    });
  });

  it("classifies a grep piped through head (the Claude Code idiom)", () => {
    const parsed = parseShellSearchCommand(
      'grep -rn "sessionSidebarRow\\|sessionDateBuckets" src --include=*.tsx --include=*.ts -l | head -20'
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.tool).toBe("grep");
    expect(parsed?.pattern).toBe("sessionSidebarRow|sessionDateBuckets");
    expect(parsed?.paths).toEqual(["src"]);
    expect(parsed?.filesOnly).toBe(true);
  });

  it("classifies multi-filter pipelines", () => {
    const parsed = parseShellSearchCommand(
      "grep -rn foo src | sort | uniq | head -5"
    );
    expect(parsed?.pattern).toBe("foo");
    expect(parsed?.paths).toEqual(["src"]);
  });

  it("classifies grep-of-grep refinement pipelines", () => {
    const parsed = parseShellSearchCommand(
      'grep -rn "foo" src | grep -v test | wc -l'
    );
    expect(parsed?.pattern).toBe("foo");
  });

  it("classifies ripgrep with flags", () => {
    const parsed = parseShellSearchCommand(
      'rg -n --type ts "useAtomValue" src/engines | head -30'
    );
    expect(parsed).toEqual({
      tool: "rg",
      pattern: "useAtomValue",
      paths: ["src/engines"],
      filesOnly: false,
    });
  });

  it("classifies rg --files as a files-only listing over the glob", () => {
    const parsed = parseShellSearchCommand('rg --files -g "*.test.ts" | head');
    expect(parsed?.filesOnly).toBe(true);
    expect(parsed?.pattern).toBe("*.test.ts");
  });

  it("takes the pattern from -e when present", () => {
    const parsed = parseShellSearchCommand("grep -rne needle src lib");
    expect(parsed?.pattern).toBe("needle");
    expect(parsed?.paths).toEqual(["src", "lib"]);
  });

  it("supports the -- positional terminator", () => {
    const parsed = parseShellSearchCommand("grep -rn -- -foo src");
    expect(parsed?.pattern).toBe("-foo");
    expect(parsed?.paths).toEqual(["src"]);
  });

  it("classifies git grep", () => {
    const parsed = parseShellSearchCommand('git grep -n "TODO" src/');
    expect(parsed?.tool).toBe("git grep");
    expect(parsed?.pattern).toBe("TODO");
  });

  it("ignores redirections", () => {
    const parsed = parseShellSearchCommand(
      "grep -rn foo src 2>/dev/null | wc -l"
    );
    expect(parsed?.pattern).toBe("foo");
    expect(parsed?.paths).toEqual(["src"]);
  });

  it("treats a quoted pipe as part of the pattern, not an operator", () => {
    const parsed = parseShellSearchCommand('grep -rn "a|b" src');
    expect(parsed?.pattern).toBe("a|b");
  });

  it("detects -l inside a combined flag cluster", () => {
    const parsed = parseShellSearchCommand("grep -rln foo src");
    expect(parsed?.filesOnly).toBe(true);
  });

  it("rejects compound commands joined by && ; or ||", () => {
    expect(parseShellSearchCommand("cd src && grep -rn foo .")).toBeNull();
    expect(parseShellSearchCommand("grep -rn foo src; ls")).toBeNull();
    expect(parseShellSearchCommand("grep -rn foo src || true")).toBeNull();
    expect(parseShellSearchCommand("grep -rn foo src &")).toBeNull();
  });

  it("rejects pipelines that do not start with a search command", () => {
    expect(parseShellSearchCommand("echo hi | grep foo")).toBeNull();
    expect(parseShellSearchCommand("cat file.txt | grep foo")).toBeNull();
    expect(parseShellSearchCommand("ls src")).toBeNull();
  });

  it("rejects pipelines feeding non-filter commands", () => {
    expect(parseShellSearchCommand("grep -rl foo src | xargs rm")).toBeNull();
    expect(
      parseShellSearchCommand("grep -rn foo src | tee /tmp/out.txt")
    ).toBeNull();
  });

  it("rejects git subcommands other than grep", () => {
    expect(parseShellSearchCommand("git log --oneline | head")).toBeNull();
  });

  it("rejects grep with no extractable pattern", () => {
    expect(parseShellSearchCommand("grep")).toBeNull();
    expect(parseShellSearchCommand("grep -rn")).toBeNull();
  });

  it("rejects empty and undefined commands", () => {
    expect(parseShellSearchCommand(undefined)).toBeNull();
    expect(parseShellSearchCommand("")).toBeNull();
    expect(parseShellSearchCommand("   ")).toBeNull();
  });
});

describe("isShellSearchCommand", () => {
  it("mirrors the parser verdict", () => {
    expect(isShellSearchCommand('grep -rn "x" src | head')).toBe(true);
    expect(isShellSearchCommand("npm run build")).toBe(false);
  });
});
