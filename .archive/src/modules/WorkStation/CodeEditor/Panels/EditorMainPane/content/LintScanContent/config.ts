import type { LanguageDef, ScopeOption } from "./types";

export const SCOPE_OPTIONS: ScopeOption[] = [
  {
    value: "opened-tabs",
    labelKey: "status.scopeOpenedTabs",
  },
  {
    value: "diff",
    labelKey: "status.scopeDiff",
  },
  {
    value: "whole-repo",
    labelKey: "status.scopeWholeRepo",
  },
];

export const TOOL_ICON_FILE: Record<string, string> = {
  eslint: "file.ts",
  tsc: "file.ts",
  stylelint: "file.css",
  "rust-analyzer": "file.rs",
  clippy: "file.rs",
  rustfmt: "file.rs",
  ruff: "file.py",
  pylint: "file.py",
  flake8: "file.py",
  mypy: "file.py",
  "golangci-lint": "file.go",
  shellcheck: "file.sh",
};

export const LANGUAGE_DEFS: LanguageDef[] = [
  {
    language: "TypeScript",
    extensions: ["ts", "tsx"],
    color: "#3178C6",
    iconFile: "file.ts",
    toolLanguageKeys: ["typescript"],
  },
  {
    language: "JavaScript",
    extensions: ["js", "jsx", "mjs", "cjs"],
    color: "#F7DF1E",
    iconFile: "file.js",
    toolLanguageKeys: ["javascript"],
  },
  {
    language: "Rust",
    extensions: ["rs"],
    color: "#DEA584",
    iconFile: "file.rs",
    toolLanguageKeys: ["rust"],
  },
  {
    language: "Python",
    extensions: ["py", "pyi"],
    color: "#3572A5",
    iconFile: "file.py",
    toolLanguageKeys: ["python"],
  },
  {
    language: "Go",
    extensions: ["go"],
    color: "#00ADD8",
    iconFile: "file.go",
    toolLanguageKeys: ["go"],
  },
  {
    language: "CSS",
    extensions: ["css", "scss", "less"],
    color: "#563D7C",
    iconFile: "file.css",
    toolLanguageKeys: ["css", "scss", "less"],
  },
  {
    language: "HTML",
    extensions: ["html", "htm"],
    color: "#E34C26",
    iconFile: "file.html",
    toolLanguageKeys: ["html"],
  },
  {
    language: "JSON",
    extensions: ["json", "jsonc"],
    color: "#A0A0A0",
    iconFile: "file.json",
    toolLanguageKeys: ["json"],
  },
  {
    language: "Shell",
    extensions: ["sh", "bash", "zsh"],
    color: "#89E051",
    iconFile: "file.sh",
    toolLanguageKeys: ["shell", "bash"],
  },
  {
    language: "TOML",
    extensions: ["toml"],
    color: "#9C4121",
    iconFile: "file.toml",
    toolLanguageKeys: ["toml"],
  },
  {
    language: "YAML",
    extensions: ["yml", "yaml"],
    color: "#CB171E",
    iconFile: "file.yaml",
    toolLanguageKeys: ["yaml"],
  },
  {
    language: "Markdown",
    extensions: ["md", "mdx"],
    color: "#083FA1",
    iconFile: "file.md",
    toolLanguageKeys: ["markdown"],
  },
  {
    language: "Ruby",
    extensions: ["rb"],
    color: "#CC342D",
    iconFile: "file.rb",
    toolLanguageKeys: ["ruby"],
  },
  {
    language: "C/C++",
    extensions: ["c", "cpp", "h", "hpp"],
    color: "#555555",
    iconFile: "file.cpp",
    toolLanguageKeys: ["c", "cpp"],
  },
  {
    language: "Java",
    extensions: ["java"],
    color: "#B07219",
    iconFile: "file.java",
    toolLanguageKeys: ["java"],
  },
  {
    language: "PHP",
    extensions: ["php"],
    color: "#4F5D95",
    iconFile: "file.php",
    toolLanguageKeys: ["php"],
  },
  {
    language: "Swift",
    extensions: ["swift"],
    color: "#F05138",
    iconFile: "file.swift",
    toolLanguageKeys: ["swift"],
  },
  {
    language: "Kotlin",
    extensions: ["kt", "kts"],
    color: "#A97BFF",
    iconFile: "file.kt",
    toolLanguageKeys: ["kotlin"],
  },
  {
    language: "Dockerfile",
    extensions: ["dockerfile"],
    color: "#384D54",
    iconFile: "Dockerfile",
    toolLanguageKeys: ["dockerfile"],
  },
  {
    language: "SQL",
    extensions: ["sql"],
    color: "#E38C00",
    iconFile: "file.sql",
    toolLanguageKeys: ["sql"],
  },
];

export const SECTION_LABEL =
  "mb-2 text-[11px] font-medium uppercase tracking-wide text-text-3";
