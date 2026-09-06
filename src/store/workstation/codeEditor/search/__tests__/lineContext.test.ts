import { describe, expect, it } from "vitest";

import { shareSearchLineContext } from "@src/store/workstation/codeEditor/search/lineContext";
import type {
  SearchMatch,
  SearchResultFile,
} from "@src/store/workstation/codeEditor/search/types";

function matchOn(
  line: string,
  lineNumber: number,
  from: number,
  to: number
): SearchMatch {
  return {
    line: lineNumber,
    column: from + 1,
    end_line: lineNumber,
    end_column: to + 1,
    // Independent copies, as JSON.parse would produce them.
    text: `${line.slice(from, to)}`,
    context_before: `${line.slice(0, from)}`,
    context_after: `${line.slice(to)}`,
  };
}

function reassemble(match: SearchMatch): string {
  return match.context_before + match.text + match.context_after;
}

describe("shareSearchLineContext", () => {
  it("re-derives every match on a repeated line from one shared string", () => {
    const line = "const a = foo(foo(1), foo(2));";
    const file: SearchResultFile = {
      file_path: "/a.ts",
      matches: [
        matchOn(line, 7, 10, 13),
        matchOn(line, 7, 14, 17),
        matchOn(line, 7, 22, 25),
      ],
    };

    const [shared] = shareSearchLineContext([file]);

    expect(shared).not.toBe(file);
    for (const [index, match] of shared.matches.entries()) {
      expect(match.text).toBe("foo");
      expect(reassemble(match)).toBe(line);
      expect(match.context_before).toBe(file.matches[index].context_before);
      expect(match.context_after).toBe(file.matches[index].context_after);
      expect(match.column).toBe(file.matches[index].column);
    }
  });

  it("passes files without repeated lines through untouched", () => {
    const file: SearchResultFile = {
      file_path: "/b.ts",
      matches: [
        matchOn("one foo here", 1, 4, 7),
        matchOn("and foo there", 2, 4, 7),
      ],
    };

    const [same] = shareSearchLineContext([file]);
    expect(same).toBe(file);
  });

  it("leaves single-match lines and multi-line matches as they are", () => {
    const repeated = "foo foo";
    const single: SearchMatch = matchOn("just foo", 1, 5, 8);
    const spanning: SearchMatch = {
      ...matchOn("foo", 3, 0, 3),
      end_line: 4,
      context_after: "\nfoo",
    };
    const file: SearchResultFile = {
      file_path: "/c.ts",
      matches: [
        single,
        matchOn(repeated, 2, 0, 3),
        matchOn(repeated, 2, 4, 7),
        spanning,
      ],
    };

    const [shared] = shareSearchLineContext([file]);
    expect(shared.matches[0]).toBe(single);
    expect(shared.matches[3]).toBe(spanning);
    expect(reassemble(shared.matches[1])).toBe(repeated);
    expect(reassemble(shared.matches[2])).toBe(repeated);
  });

  it("keeps a match's own strings when they do not reassemble the shared line", () => {
    const odd: SearchMatch = {
      line: 9,
      column: 1,
      end_line: 9,
      end_column: 4,
      text: "foo",
      context_before: "",
      context_after: " (from a different snapshot)",
    };
    const file: SearchResultFile = {
      file_path: "/d.ts",
      matches: [matchOn("foo bar foo", 9, 0, 3), odd],
    };

    const [shared] = shareSearchLineContext([file]);
    expect(shared.matches[1]).toBe(odd);
    expect(reassemble(shared.matches[0])).toBe("foo bar foo");
  });
});
