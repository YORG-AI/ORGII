import {
  extractFileName,
  isFileEditEvent,
  isFileViewEvent,
  isSearchEvent,
  normalizeFileEditPayload,
  normalizeFileViewPayload,
  normalizeSearchPayload,
} from "../eventPayload";

describe("extractFileName", () => {
  it("returns basename for nested path", () => {
    expect(extractFileName("src/components/Button.tsx")).toBe("Button.tsx");
  });

  it("returns file for empty string", () => {
    expect(extractFileName("")).toBe("file");
  });

  it("returns input when there are no slashes", () => {
    expect(extractFileName("readme.txt")).toBe("readme.txt");
  });
});

describe("isFileEditEvent", () => {
  it("returns true for file edit function names", () => {
    expect(isFileEditEvent("file_diff")).toBe(true);
    expect(isFileEditEvent("create_file")).toBe(true);
    expect(isFileEditEvent("edit_file_by_replace")).toBe(true);
  });

  it("returns false for non-edit function names", () => {
    expect(isFileEditEvent("read_file")).toBe(false);
    expect(isFileEditEvent("search_directory")).toBe(false);
  });
});

describe("isFileViewEvent", () => {
  it("returns true for file view function names", () => {
    expect(isFileViewEvent("read_file")).toBe(true);
    expect(isFileViewEvent("view_file")).toBe(true);
  });

  it("returns false for create_file", () => {
    expect(isFileViewEvent("create_file")).toBe(false);
  });
});

describe("isSearchEvent", () => {
  it("returns true for search function names", () => {
    expect(isSearchEvent("search_directory")).toBe(true);
    expect(isSearchEvent("search_codebase")).toBe(true);
    expect(isSearchEvent("codebase_search")).toBe(true);
  });

  it("returns false for read_file", () => {
    expect(isSearchEvent("read_file")).toBe(false);
  });
});

describe("normalizeFileEditPayload", () => {
  it("normalizes create_file", () => {
    const normalized = normalizeFileEditPayload({
      function: "create_file",
      args: { file_name: "test.ts", content: "hello" },
      result: {},
    });
    expect(normalized.filePath).toBe("test.ts");
    expect(normalized.newContent).toBe("hello");
    expect(normalized.isCreateFile).toBe(true);
  });

  it("normalizes edit_file_by_replace", () => {
    const normalized = normalizeFileEditPayload({
      function: "edit_file_by_replace",
      args: {
        file_path: "src/main.ts",
        old_string: "foo",
        new_string: "bar",
      },
      result: {},
    });
    expect(normalized.filePath).toBe("src/main.ts");
    expect(normalized.oldContent).toBe("foo");
    expect(normalized.newContent).toBe("bar");
  });

  it("normalizes backend Edit alias with diff in result", () => {
    const normalized = normalizeFileEditPayload({
      function: "Edit",
      args: { file_path: "test.ts" },
      result: {
        output: {
          success: {
            diff: { path: "test.ts", old_text: "a", new_text: "b" },
          },
        },
      },
    });
    expect(normalized.filePath).toBe("test.ts");
    expect(normalized.oldContent).toBe("a");
    expect(normalized.newContent).toBe("b");
  });

  it("normalizes file_diff with JSON string per path", () => {
    const normalized = normalizeFileEditPayload({
      function: "file_diff",
      args: {},
      result: {
        "app/x.ts": JSON.stringify({ old_copy: "old", new_copy: "new" }),
      },
    });
    expect(normalized.filePath).toBe("app/x.ts");
    expect(normalized.oldContent).toBe("old");
    expect(normalized.newContent).toBe("new");
    expect(normalized.isCreateFile).toBe(false);
  });
});

describe("normalizeFileViewPayload", () => {
  it("normalizes direct read_file result", () => {
    const normalized = normalizeFileViewPayload({
      function: "read_file",
      args: { file_path: "test.ts" },
      result: { content: "hello", total_lines: 10 },
    });
    expect(normalized.filePath).toBe("test.ts");
    expect(normalized.content).toBe("hello");
    expect(normalized.totalLines).toBe(10);
  });

  it("normalizes backend read_file with path and output.success", () => {
    const normalized = normalizeFileViewPayload({
      function: "read_file",
      args: { path: "test.ts" },
      result: { output: { success: { content: "data" } } },
    });
    expect(normalized.filePath).toBe("test.ts");
    expect(normalized.content).toBe("data");
  });

  it("normalizes Cursor camel-case read_file target paths", () => {
    const normalized = normalizeFileViewPayload({
      function: "Read",
      args: { targetFile: "/Users/vinceorz/Projects/ORGII/src/app/root.tsx" },
      result: { content: "data" },
    });
    expect(normalized.filePath).toBe(
      "/Users/vinceorz/Projects/ORGII/src/app/root.tsx"
    );
    expect(normalized.fileName).toBe("root.tsx");
  });

  it("returns empty content when result is missing", () => {
    const normalized = normalizeFileViewPayload({
      function: "read_file",
      args: { file_path: "x.ts" },
    });
    expect(normalized.content).toBe("");
    expect(normalized.filePath).toBe("x.ts");
  });
});

describe("normalizeSearchPayload", () => {
  it("normalizes search_directory with total count and file entries", () => {
    const normalized = normalizeSearchPayload({
      function: "search_directory",
      args: { query: "foo", directory: "src" },
      result: {
        _total_match_count: "2",
        "a.ts": [{ lineNumber: 1, content: "foo" }],
        "b.ts": [{ lineNumber: 3, content: "foo bar" }],
      },
    });
    expect(normalized.query).toBe("foo");
    expect(normalized.directory).toBe("src");
    expect(normalized.totalCount).toBe(2);
    expect(normalized.results.length).toBe(2);
    expect(normalized.results[0]?.filePath).toBe("a.ts");
    expect(normalized.results[0]?.matches[0]?.lineNumber).toBe(1);
    expect(normalized.results[0]?.matches[0]?.content).toBe("foo");
  });

  it("normalizes codebase_search with content array", () => {
    const normalized = normalizeSearchPayload({
      function: "codebase_search",
      args: { pattern: "api" },
      result: {
        content: [
          {
            name: "src/api.ts",
            lineNumber: 4,
            content: "export function api() {}",
          },
        ],
      },
    });
    expect(normalized.query).toBe("api");
    expect(normalized.totalCount).toBe(1);
    expect(normalized.results[0]?.filePath).toBe("src/api.ts");
    expect(normalized.results[0]?.matches[0]?.lineNumber).toBe(4);
    expect(normalized.results[0]?.matches[0]?.content).toBe(
      "export function api() {}"
    );
  });
});
