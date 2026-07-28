import { describe, expect, it } from "vitest";

import { extractSearchData } from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// extractSearchData
// ============================================

describe("extractSearchData", () => {
  describe("query extraction from various arg keys", () => {
    it("extracts from args.query", () => {
      const props = makeUniversalProps({ args: { query: "handleSubmit" } });
      expect(extractSearchData(props).query).toBe("handleSubmit");
    });

    it("extracts from args.pattern", () => {
      const props = makeUniversalProps({ args: { pattern: "foo.*bar" } });
      expect(extractSearchData(props).query).toBe("foo.*bar");
    });

    it("extracts from args.search_query", () => {
      const props = makeUniversalProps({
        args: { search_query: "authentication" },
      });
      expect(extractSearchData(props).query).toBe("authentication");
    });

    it("extracts from args.regex", () => {
      const props = makeUniversalProps({ args: { regex: "^import" } });
      expect(extractSearchData(props).query).toBe("^import");
    });

    it("extracts from args.search_term", () => {
      const props = makeUniversalProps({
        args: { search_term: "react hooks" },
      });
      expect(extractSearchData(props).query).toBe("react hooks");
    });

    it("extracts from args.searchTerm (camelCase)", () => {
      const props = makeUniversalProps({
        args: { searchTerm: "camelQuery" },
      });
      expect(extractSearchData(props).query).toBe("camelQuery");
    });

    it("extracts from args.text", () => {
      const props = makeUniversalProps({ args: { text: "search text" } });
      expect(extractSearchData(props).query).toBe("search text");
    });

    it("extracts from args.input", () => {
      const props = makeUniversalProps({ args: { input: "input query" } });
      expect(extractSearchData(props).query).toBe("input query");
    });

    it("returns empty string when no query source found", () => {
      const props = makeUniversalProps({ args: {} });
      expect(extractSearchData(props).query).toBe("");
    });

    it("args.query takes priority over args.pattern", () => {
      const props = makeUniversalProps({
        args: { query: "primary", pattern: "secondary" },
      });
      expect(extractSearchData(props).query).toBe("primary");
    });
  });

  describe("matches parsing", () => {
    it("parses result.matches array into structured results", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [
            { file: "src/a.ts", line: 10, content: "test function" },
            { file: "src/b.ts", line: 20, content: "another test" },
          ],
          total: 2,
        },
      });
      const data = extractSearchData(props);
      expect(data.results).toHaveLength(2);
      expect(data.results![0]).toEqual({
        file: "src/a.ts",
        line: 10,
        content: "test function",
      });
      expect(data.results![1]).toEqual({
        file: "src/b.ts",
        line: 20,
        content: "another test",
      });
    });

    it("returns empty array when result.matches is not an array", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: { matches: "not an array" },
      });
      expect(extractSearchData(props).results).toEqual([]);
    });

    it("returns empty array when result.matches is undefined", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {},
      });
      expect(extractSearchData(props).results).toEqual([]);
    });

    it("falls back to ripgrep text when rustExtracted search is empty", () => {
      const props = makeUniversalProps({
        args: { pattern: "require\\('../../src/database" },
        rustExtracted: {
          kind: "search",
          query: "require\\('../../src/database",
          results: [],
          totalMatches: 77,
        },
        result: {
          content:
            "/repo/test/mocks/databasemock.js-128-\n" +
            "/repo/test/mocks/databasemock.js:129:const db = require('../../src/database');",
        },
      });
      const data = extractSearchData(props);
      expect(data.results).toEqual([
        {
          file: "/repo/test/mocks/databasemock.js",
          line: 129,
          content: "const db = require('../../src/database');",
        },
      ]);
      expect(data.totalMatches).toBe(1);
    });
  });

  describe("totalMatches", () => {
    it("uses result.total when available", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [{ file: "a.ts", line: 1, content: "x" }],
          total: 50,
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(50);
    });

    it("falls back to results.length when no total", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          matches: [
            { file: "a.ts", line: 1, content: "x" },
            { file: "b.ts", line: 2, content: "y" },
          ],
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(2);
    });

    it("parses totalMatches from text summary regex", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          content: "Found 9 matches in 4 files",
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(9);
    });

    it("parses totalMatches from plain digit+match format", () => {
      const props = makeUniversalProps({
        args: { query: "test" },
        result: {
          content: "42 matches found across the codebase",
        },
      });
      expect(extractSearchData(props).totalMatches).toBe(42);
    });

    it("returns 0 when no matches and no summary text", () => {
      const props = makeUniversalProps({
        args: { query: "noresults" },
        result: { content: "No results found" },
      });
      expect(extractSearchData(props).totalMatches).toBe(0);
    });
  });
});
