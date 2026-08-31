import {
  LANGUAGE_MAP,
  getLanguageDisplayNameFromPath,
  getLanguageFromPath,
  getLanguageIconFile,
  getLanguageMetadataFromExtension,
  getSyntaxHighlighterLanguage,
  getSyntaxHighlighterLanguageFromPath,
} from "./languageMap";

describe("language metadata registry", () => {
  it("preserves the editor/LSP extension contract", () => {
    expect(LANGUAGE_MAP).toEqual({
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      mjs: "javascript",
      cjs: "javascript",
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      sass: "sass",
      less: "less",
      vue: "vue",
      svelte: "svelte",
      py: "python",
      pyi: "python",
      rb: "ruby",
      php: "php",
      java: "java",
      kt: "kotlin",
      kts: "kotlin",
      scala: "scala",
      go: "go",
      rs: "rust",
      c: "c",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      h: "c",
      hpp: "cpp",
      hxx: "cpp",
      cs: "csharp",
      swift: "swift",
      m: "objectivec",
      mm: "objectivec",
      json: "json",
      jsonc: "jsonc",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      xml: "xml",
      md: "markdown",
      mdx: "mdx",
      txt: "plaintext",
      sh: "shellscript",
      bash: "shellscript",
      zsh: "shellscript",
      fish: "fish",
      ps1: "powershell",
      sql: "sql",
      dockerfile: "dockerfile",
      makefile: "makefile",
      cmake: "cmake",
      tf: "hcl",
      graphql: "graphql",
      gql: "graphql",
      proto: "protobuf",
      prisma: "prisma",
      hs: "haskell",
      elm: "elm",
      clj: "clojure",
      cljs: "clojurescript",
      cljc: "clojure",
      ml: "ocaml",
      mli: "ocaml",
      ex: "elixir",
      exs: "elixir",
      erl: "erlang",
      lua: "lua",
      perl: "perl",
      pl: "perl",
      r: "r",
      dart: "dart",
      zig: "zig",
      vim: "vim",
    });
  });

  it.each([
    {
      filePath: "src/App.tsx",
      editorLanguageId: "typescriptreact",
      syntaxHighlighterId: "tsx",
      displayName: "TypeScript React",
      iconFile: "file.tsx",
    },
    {
      filePath: "src/Program.cs",
      editorLanguageId: "csharp",
      syntaxHighlighterId: "csharp",
      displayName: "C#",
      iconFile: "file.cs",
    },
    {
      filePath: "scripts/release.sh",
      editorLanguageId: "shellscript",
      syntaxHighlighterId: "bash",
      displayName: "Shell",
      iconFile: "file.sh",
    },
  ])(
    "keeps each consumer ID explicit for $filePath",
    ({
      filePath,
      editorLanguageId,
      syntaxHighlighterId,
      displayName,
      iconFile,
    }) => {
      const extension = filePath.split(".").pop() ?? "";

      expect(getLanguageFromPath(filePath)).toBe(editorLanguageId);
      expect(getSyntaxHighlighterLanguageFromPath(filePath)).toBe(
        syntaxHighlighterId
      );
      expect(getLanguageDisplayNameFromPath(filePath)).toBe(displayName);
      expect(getLanguageIconFile(extension)).toBe(iconFile);
      expect(getLanguageMetadataFromExtension(extension)?.displayName).toBe(
        displayName
      );
    }
  );

  it("resolves special filenames and filename prefixes from the registry", () => {
    expect(getLanguageDisplayNameFromPath("project/Dockerfile")).toBe(
      "Dockerfile"
    );
    expect(getLanguageDisplayNameFromPath("project/.env.local")).toBe(
      "Environment"
    );
  });

  it("owns Prism IDs for editor IDs, extensions, and legacy aliases", () => {
    expect(getSyntaxHighlighterLanguage("typescriptreact")).toBe("tsx");
    expect(getSyntaxHighlighterLanguage("shellscript")).toBe("bash");
    expect(getSyntaxHighlighterLanguage("console")).toBe("shell-session");
    expect(getSyntaxHighlighterLanguage("golang")).toBe("go");
    expect(getSyntaxHighlighterLanguage("objective-c")).toBe("objectivec");
    expect(getSyntaxHighlighterLanguage("jsonc")).toBe("json");
    expect(getSyntaxHighlighterLanguage("txt")).toBe("log");
    expect(getSyntaxHighlighterLanguageFromPath("src/lib.rs")).toBe("rust");
    expect(getSyntaxHighlighterLanguageFromPath("~/.bashrc")).toBe("bash");
  });

  it("preserves editor fallbacks for unknown extensions", () => {
    expect(getLanguageFromPath("file.unknown")).toBeUndefined();
    expect(getLanguageFromPath("file.unknown", "text")).toBe("text");
  });
});
