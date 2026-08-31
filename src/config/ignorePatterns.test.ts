/**
 * Tests for .orgiiignore pattern parsing and matching.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_IGNORE_PATTERNS,
  filterIgnoredPaths,
  getDefaultPatterns,
  matchesPattern,
  parseIgnoreFile,
  patternsFromStrings,
  shouldIgnore,
} from "./ignorePatterns";

describe("ignorePatterns", () => {
  describe("DEFAULT_IGNORE_PATTERNS", () => {
    it("includes common package manager directories", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("vendor/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain(".pnpm/");
    });

    it("includes version control directories", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain(".git/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain(".svn/");
    });

    it("includes build output directories", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("dist/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("build/");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("target/");
    });

    it("includes lock files", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("package-lock.json");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("yarn.lock");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("Cargo.lock");
    });

    it("includes minified files", () => {
      expect(DEFAULT_IGNORE_PATTERNS).toContain("*.min.js");
      expect(DEFAULT_IGNORE_PATTERNS).toContain("*.min.css");
    });
  });

  describe("parseIgnoreFile", () => {
    it("parses simple patterns", () => {
      const content = "node_modules/\ndist/\n*.log";
      const patterns = parseIgnoreFile(content);

      expect(patterns).toHaveLength(3);
      expect(patterns[0].pattern).toBe("node_modules/");
      expect(patterns[1].pattern).toBe("dist/");
      expect(patterns[2].pattern).toBe("*.log");
    });

    it("skips empty lines", () => {
      const content = "first\n\nsecond\n\n\nthird";
      const patterns = parseIgnoreFile(content);

      expect(patterns).toHaveLength(3);
    });

    it("skips comment lines", () => {
      const content = "# This is a comment\npattern\n# Another comment";
      const patterns = parseIgnoreFile(content);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].pattern).toBe("pattern");
    });

    it("trims whitespace", () => {
      const content = "  pattern  \n\ttabbed\t";
      const patterns = parseIgnoreFile(content);

      expect(patterns).toHaveLength(2);
      expect(patterns[0].pattern).toBe("pattern");
      expect(patterns[1].pattern).toBe("tabbed");
    });

    it("detects negated patterns (!)", () => {
      const content = "*.log\n!important.log";
      const patterns = parseIgnoreFile(content);

      expect(patterns).toHaveLength(2);
      expect(patterns[0].negated).toBe(false);
      expect(patterns[1].negated).toBe(true);
      expect(patterns[1].pattern).toBe("important.log");
    });

    it("detects directory patterns (/)", () => {
      const content = "node_modules/\nfile.txt";
      const patterns = parseIgnoreFile(content);

      expect(patterns[0].isDirectory).toBe(true);
      expect(patterns[1].isDirectory).toBe(false);
    });
  });

  describe("patternsFromStrings", () => {
    it("converts string array to IgnorePattern array", () => {
      const patterns = patternsFromStrings(["*.js", "dist/", "!keep.js"]);

      expect(patterns).toHaveLength(3);
      expect(patterns[0].pattern).toBe("*.js");
      expect(patterns[1].isDirectory).toBe(true);
      expect(patterns[2].negated).toBe(true);
    });
  });

  describe("getDefaultPatterns", () => {
    it("returns parsed default patterns", () => {
      const patterns = getDefaultPatterns();

      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.some((p) => p.pattern === "node_modules/")).toBe(true);
    });
  });

  describe("matchesPattern", () => {
    it("matches exact file names", () => {
      const pattern = {
        pattern: "file.txt",
        negated: false,
        isDirectory: false,
      };

      expect(matchesPattern("file.txt", pattern)).toBe(true);
      expect(matchesPattern("src/file.txt", pattern)).toBe(true);
      expect(matchesPattern("other.txt", pattern)).toBe(false);
    });

    it("matches wildcard patterns (*)", () => {
      const pattern = { pattern: "*.log", negated: false, isDirectory: false };

      expect(matchesPattern("error.log", pattern)).toBe(true);
      expect(matchesPattern("debug.log", pattern)).toBe(true);
      expect(matchesPattern("src/app.log", pattern)).toBe(true);
      expect(matchesPattern("file.txt", pattern)).toBe(false);
    });

    it("matches double wildcard patterns (**)", () => {
      // Pattern "test/" matches directories named test anywhere in the path
      const pattern = {
        pattern: "test/",
        negated: false,
        isDirectory: true,
      };

      expect(matchesPattern("test", pattern)).toBe(true);
      expect(matchesPattern("test/file.js", pattern)).toBe(true);
      expect(matchesPattern("src/test/file.js", pattern)).toBe(true);
    });

    it("matches directory patterns", () => {
      const pattern = {
        pattern: "node_modules/",
        negated: false,
        isDirectory: true,
      };

      expect(matchesPattern("node_modules", pattern)).toBe(true);
      expect(matchesPattern("node_modules/lodash", pattern)).toBe(true);
      expect(matchesPattern("src/node_modules/pkg", pattern)).toBe(true);
    });

    it("matches root-relative patterns (/)", () => {
      const pattern = {
        pattern: "/root.txt",
        negated: false,
        isDirectory: false,
      };

      expect(matchesPattern("root.txt", pattern)).toBe(true);
      expect(matchesPattern("src/root.txt", pattern)).toBe(false);
    });

    it("matches single character wildcard (?)", () => {
      const pattern = {
        pattern: "file?.txt",
        negated: false,
        isDirectory: false,
      };

      expect(matchesPattern("file1.txt", pattern)).toBe(true);
      expect(matchesPattern("fileA.txt", pattern)).toBe(true);
      expect(matchesPattern("file10.txt", pattern)).toBe(false);
    });
  });

  describe("shouldIgnore", () => {
    it("returns true for matching patterns", () => {
      const patterns = patternsFromStrings(["*.log", "node_modules/"]);

      expect(shouldIgnore("error.log", patterns)).toBe(true);
      expect(shouldIgnore("node_modules/pkg", patterns)).toBe(true);
    });

    it("returns false for non-matching paths", () => {
      const patterns = patternsFromStrings(["*.log"]);

      expect(shouldIgnore("file.txt", patterns)).toBe(false);
    });

    it("handles negation patterns correctly", () => {
      const patterns = patternsFromStrings(["*.log", "!important.log"]);

      expect(shouldIgnore("debug.log", patterns)).toBe(true);
      expect(shouldIgnore("important.log", patterns)).toBe(false);
    });

    it("later patterns override earlier ones", () => {
      const patterns = patternsFromStrings([
        "!keep.txt", // First: don't ignore
        "*.txt", // Then: ignore all .txt
        "!keep.txt", // Finally: don't ignore keep.txt
      ]);

      expect(shouldIgnore("keep.txt", patterns)).toBe(false);
      expect(shouldIgnore("other.txt", patterns)).toBe(true);
    });

    it("returns false for empty pattern list", () => {
      expect(shouldIgnore("anything.txt", [])).toBe(false);
    });
  });

  describe("filterIgnoredPaths", () => {
    it("removes ignored paths from array", () => {
      const paths = [
        "src/index.ts",
        "node_modules/lodash/index.js",
        "dist/bundle.js",
        "README.md",
      ];
      const patterns = patternsFromStrings(["node_modules/", "dist/"]);

      const filtered = filterIgnoredPaths(paths, patterns);

      expect(filtered).toEqual(["src/index.ts", "README.md"]);
    });

    it("keeps all paths when no patterns match", () => {
      const paths = ["src/a.ts", "src/b.ts"];
      const patterns = patternsFromStrings(["*.log"]);

      const filtered = filterIgnoredPaths(paths, patterns);

      expect(filtered).toEqual(paths);
    });

    it("removes all paths when all match", () => {
      const paths = ["a.log", "b.log", "c.log"];
      const patterns = patternsFromStrings(["*.log"]);

      const filtered = filterIgnoredPaths(paths, patterns);

      expect(filtered).toEqual([]);
    });

    it("respects negation patterns", () => {
      const paths = ["debug.log", "error.log", "important.log"];
      const patterns = patternsFromStrings(["*.log", "!important.log"]);

      const filtered = filterIgnoredPaths(paths, patterns);

      expect(filtered).toEqual(["important.log"]);
    });
  });
});
