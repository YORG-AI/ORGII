/**
 * Configuration constants for Language Servers Page
 */

/** Map language id to representative filename for FileTypeIcon */
export const LANGUAGE_ICON_FILE: Record<string, string> = {
  rust: "file.rs",
  typescript: "file.ts",
  javascript: "file.js",
  python: "file.py",
  go: "file.go",
  c: "file.c",
  cpp: "file.cpp",
  csharp: "file.cs",
  java: "file.java",
  kotlin: "file.kt",
  ruby: "file.rb",
  php: "file.php",
  swift: "file.swift",
  scala: "file.scala",
  lua: "file.lua",
  html: "file.html",
  css: "file.css",
  json: "file.json",
  markdown: "file.md",
  docker: "Dockerfile",
  clojure: "file.clj",
  elixir: "file.ex",
  haskell: "file.hs",
  ocaml: "file.ml",
  zig: "file.zig",
};

export const LSP_DOCS_URL: Record<string, string> = {
  typescript:
    "https://github.com/typescript-language-server/typescript-language-server",
  javascript:
    "https://github.com/typescript-language-server/typescript-language-server",
  html: "https://github.com/microsoft/vscode-languageserver-node",
  css: "https://github.com/microsoft/vscode-languageserver-node",
  json: "https://github.com/microsoft/vscode-languageserver-node",
  vue: "https://github.com/vuejs/language-tools",
  svelte: "https://github.com/sveltejs/language-tools",
  rust: "https://rust-analyzer.github.io",
  c: "https://clangd.llvm.org",
  cpp: "https://clangd.llvm.org",
  go: "https://pkg.go.dev/golang.org/x/tools/gopls",
  zig: "https://github.com/zigtools/zls",
  java: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  kotlin: "https://github.com/fwcd/kotlin-language-server",
  scala: "https://scalameta.org/metals",
  python: "https://microsoft.github.io/pyright",
  ruby: "https://solargraph.org",
  php: "https://intelephense.com",
  lua: "https://luals.github.io",
  elixir: "https://github.com/elixir-lsp/elixir-ls",
  swift: "https://github.com/swiftlang/sourcekit-lsp",
  csharp: "https://www.omnisharp.net",
  haskell: "https://haskell-language-server.readthedocs.io",
  ocaml: "https://github.com/ocaml/ocaml-lsp",
  clojure: "https://clojure-lsp.io",
  yaml: "https://github.com/redhat-developer/yaml-language-server",
  markdown: "https://github.com/artempyanykh/marksman",
  shellscript: "https://github.com/bash-lsp/bash-language-server",
  dockerfile: "https://github.com/rcjsuen/dockerfile-language-server",
  sql: "https://github.com/joe-re/sql-language-server",
};

/**
 * Derive uninstall command from install hint by reversing the verb.
 */
export function deriveUninstallHint(installHint: string): string | undefined {
  const hint = installHint.toLowerCase();
  if (hint.startsWith("npm install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("pip install") || hint.startsWith("pip3 install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("brew install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("gem install"))
    return installHint.replace(/\binstall\b/, "uninstall");
  if (hint.startsWith("go install"))
    return installHint.replace("install", "clean -i").replace("@latest", "");
  if (hint.includes("rustup component add"))
    return installHint.replace("add", "remove");
  if (hint.startsWith("opam install"))
    return installHint.replace(/\binstall\b/, "remove");
  return undefined;
}

/**
 * Detect the package manager from an install hint string.
 */
export function detectPackageManager(installHint: string): string {
  const hint = installHint.toLowerCase();
  if (hint.startsWith("npm ")) return "npm";
  if (hint.startsWith("pip ") || hint.startsWith("pip3 ")) return "pip";
  if (hint.startsWith("brew ")) return "Homebrew";
  if (hint.startsWith("gem ")) return "gem";
  if (hint.startsWith("go ")) return "go";
  if (hint.includes("rustup")) return "rustup";
  if (hint.startsWith("cargo ")) return "Cargo";
  if (hint.startsWith("opam ")) return "opam";
  if (hint.startsWith("dotnet ")) return "dotnet";
  return "Shell";
}
