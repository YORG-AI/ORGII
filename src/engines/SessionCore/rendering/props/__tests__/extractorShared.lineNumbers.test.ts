import { describe, expect, it } from "vitest";

import { stripLineNumberPrefixes } from "../extractorShared";
import { extractFileData } from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// stripLineNumberPrefixes
// ============================================

describe("stripLineNumberPrefixes", () => {
  describe("Rust `read_file` format (`│` / `→` separator)", () => {
    it("strips the current `│` separator and reports the start line", () => {
      const result = stripLineNumberPrefixes(
        ["  1│const a = 1;", "  2│const b = 2;"].join("\n")
      );

      expect(result.content).toBe("const a = 1;\nconst b = 2;");
      expect(result.startLine).toBe(1);
      expect(result.lineCount).toBe(2);
    });

    it("strips the legacy `→` separator on a ranged read", () => {
      const result = stripLineNumberPrefixes(
        [" 40→const a = 1;", " 41→const b = 2;"].join("\n")
      );

      expect(result.content).toBe("const a = 1;\nconst b = 2;");
      expect(result.startLine).toBe(40);
    });

    it("drops the `[action: ...]` marker and the ranged-read footer", () => {
      const result = stripLineNumberPrefixes(
        [
          "[action: read_text]",
          "  7│const a = 1;",
          "  8│const b = 2;",
          "[Showing lines 7-8 of 400 total (2 lines)]",
        ].join("\n")
      );

      expect(result.content).toBe("const a = 1;\nconst b = 2;");
      expect(result.startLine).toBe(7);
      expect(result.lineCount).toBe(2);
    });
  });

  describe("Claude Code `Read` format (`cat -n`, TAB separator)", () => {
    it("strips `<digits><TAB>` prefixes so the gutter is not doubled", () => {
      const result = stripLineNumberPrefixes(
        ["1\t/**", "2\t * Doc comment.", "3\t */"].join("\n")
      );

      expect(result.content).toBe("/**\n * Doc comment.\n */");
      expect(result.startLine).toBe(1);
      expect(result.lineCount).toBe(3);
    });

    it("recovers the start line of a ranged read", () => {
      const result = stripLineNumberPrefixes(
        ["60\t  if (a) return a;", "61\t  return b;"].join("\n")
      );

      expect(result.content).toBe("  if (a) return a;\n  return b;");
      expect(result.startLine).toBe(60);
    });

    it("keeps right-aligned padding out of the content", () => {
      const result = stripLineNumberPrefixes(
        ["  9\tconst a = 1;", " 10\tconst b = 2;"].join("\n")
      );

      expect(result.content).toBe("const a = 1;\nconst b = 2;");
      expect(result.startLine).toBe(9);
    });

    it("preserves blank source lines, which arrive as a bare number + TAB", () => {
      const result = stripLineNumberPrefixes(
        ["1\tconst a = 1;", "2\t", "3\tconst b = 2;"].join("\n")
      );

      expect(result.content).toBe("const a = 1;\n\nconst b = 2;");
      expect(result.lineCount).toBe(3);
    });

    it("preserves tabs that belong to the source line", () => {
      const result = stripLineNumberPrefixes("1\t\tindented();");

      expect(result.content).toBe("\tindented();");
    });

    it("drops a leading <system-reminder> block", () => {
      // Observed on memory-file reads: a staleness notice precedes the body.
      const result = stripLineNumberPrefixes(
        [
          "<system-reminder>This memory is 7 days old.</system-reminder>",
          "1\t---",
          "2\tname: a-memory",
        ].join("\n")
      );

      expect(result.content).toBe("---\nname: a-memory");
      expect(result.startLine).toBe(1);
      expect(result.lineCount).toBe(2);
    });

    it("keeps a `<system-reminder>` that is part of the file's own text", () => {
      // The tag sits after a line-number prefix, so it is source, not a notice.
      const source = [
        "1\tconst RE = /<system-reminder>[\\s\\S]*?<\\/system-reminder>/g;",
        "2\texport default RE;",
      ].join("\n");

      const result = stripLineNumberPrefixes(source);

      expect(result.content).toBe(
        "const RE = /<system-reminder>[\\s\\S]*?<\\/system-reminder>/g;\nexport default RE;"
      );
      expect(result.lineCount).toBe(2);
    });

    it("drops a trailing <system-reminder> block", () => {
      const result = stripLineNumberPrefixes(
        [
          "1\tconst a = 1;",
          "2\tconst b = 2;",
          "",
          "<system-reminder>Whenever you read a file...</system-reminder>",
        ].join("\n")
      );

      expect(result.content).toBe("const a = 1;\nconst b = 2;");
      expect(result.lineCount).toBe(2);
    });
  });

  describe("content that must be left alone", () => {
    it("leaves a TSV with a sequential id column untouched", () => {
      const tsv = ["1\tAlice\t30", "2\tBob\t41", "3\tCarol\t28"].join("\n");
      // A trailing unnumbered row proves the body is data, not `cat -n` output.
      const withHeaderFooter = `${tsv}\ntotal\t3 rows`;

      expect(stripLineNumberPrefixes(withHeaderFooter).content).toBe(
        withHeaderFooter
      );
      expect(
        stripLineNumberPrefixes(withHeaderFooter).startLine
      ).toBeUndefined();
    });

    it("leaves tab-separated rows whose numbers are not consecutive", () => {
      const rows = ["1\tAlice", "5\tBob", "9\tCarol"].join("\n");

      expect(stripLineNumberPrefixes(rows).content).toBe(rows);
      expect(stripLineNumberPrefixes(rows).startLine).toBeUndefined();
    });

    it("leaves plain file content untouched", () => {
      const plain = 'import { a } from "b";\n\nexport const c = 1;';

      const result = stripLineNumberPrefixes(plain);
      expect(result.content).toBe(plain);
      expect(result.startLine).toBeUndefined();
      expect(result.lineCount).toBe(3);
    });

    it("leaves a reminder-only result (empty file) untouched", () => {
      const warning =
        "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";

      const result = stripLineNumberPrefixes(warning);
      expect(result.content).toBe(warning);
      expect(result.startLine).toBeUndefined();
    });

    it("leaves content whose unterminated reminder tag is source text", () => {
      const source = "<system-reminder>\tnot a real block\nplain\ttext";

      expect(stripLineNumberPrefixes(source).content).toBe(source);
    });

    it("leaves space-separated numeric text untouched", () => {
      const text = "1 first\n2 second";

      expect(stripLineNumberPrefixes(text).content).toBe(text);
    });
  });
});

// ============================================
// Result cache
// ============================================

describe("stripLineNumberPrefixes caching", () => {
  it("does not serve a stale read of a same-length file", () => {
    // Both versions share length, first 100 chars and last 100 chars — the
    // shape that collided in real sessions when a file was re-read after an
    // in-place edit.
    const head = Array.from(
      { length: 6 },
      (_, i) => `${i + 1}\t${"a".repeat(30)}`
    );
    const tail = Array.from(
      { length: 6 },
      (_, i) => `${i + 8}\t${"b".repeat(30)}`
    );
    const build = (middle: string) =>
      [...head, `7\t${middle}`, ...tail].join("\n");

    const first = stripLineNumberPrefixes(build("const size = 32;"));
    const second = stripLineNumberPrefixes(build("const size = 36;"));

    expect(first.content).toContain("const size = 32;");
    expect(second.content).toContain("const size = 36;");
  });
});

// ============================================
// extractFileData — Claude Code `Read` events
// ============================================

describe("extractFileData with Claude Code `Read` results", () => {
  it("hands the viewer un-numbered content plus the real start line", () => {
    const props = makeUniversalProps({
      args: { file_path: "src/a.ts", offset: 59, limit: 2 },
      result: {
        content: ["60\t  if (a) return a;", "61\t  return b;"].join("\n"),
      },
    });

    const data = extractFileData(props);

    expect(data.content).toBe("  if (a) return a;\n  return b;");
    expect(data.startLine).toBe(60);
  });

  it("recovers the start line of an offset-only read from the prefixes", () => {
    const props = makeUniversalProps({
      // No `limit`, so `readLineMetadata` yields nothing — the prefixes are
      // the only source of the offset.
      args: { file_path: "src/a.ts", offset: 99 },
      result: {
        content: ["100\tconst a = 1;", "101\tconst b = 2;"].join("\n"),
      },
    });

    expect(extractFileData(props).startLine).toBe(100);
  });
});
