/**
 * FileTypeIcon Utilities
 *
 * File type detection logic based on filename/extension.
 */
import type { FileType } from "./types";

/**
 * Get file type from filename
 *
 * Detects file type based on:
 * 1. Special file names (Dockerfile, package.json, etc.)
 * 2. Config file patterns (.eslintrc, webpack.config.js, etc.)
 * 3. Test file patterns (.test.ts, .spec.js, etc.)
 * 4. File extension mapping
 */
export function getFileTypeFromName(fileName: string): FileType {
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith("/")) {
    return "folder";
  }
  const ext = lowerFileName.split(".").pop() || "";
  const baseName = lowerFileName.split("/").pop() || lowerFileName;

  // Special file names
  if (baseName === "dockerfile" || baseName.startsWith("dockerfile."))
    return "docker";
  if (baseName === "docker-compose.yml" || baseName === "docker-compose.yaml")
    return "docker";
  if (
    baseName === ".gitignore" ||
    baseName === ".gitattributes" ||
    baseName === ".gitmodules"
  )
    return "git";
  if (baseName === "makefile" || baseName === "gnumakefile") return "makefile";
  if (baseName === "cmakelists.txt") return "cmake";
  if (baseName === "package.json") return "npm";
  if (baseName === "pnpm-lock.yaml" || baseName === "pnpm-workspace.yaml")
    return "pnpm";
  if (baseName === "yarn.lock") return "yarn";
  if (baseName === "package-lock.json") return "npm";
  if (
    baseName.startsWith(".eslintrc") ||
    baseName === "eslint.config.js" ||
    baseName === "eslint.config.mjs"
  )
    return "eslint";
  if (baseName.startsWith(".prettierrc") || baseName === "prettier.config.js")
    return "prettier";
  if (baseName === ".npmrc") return "npm";
  if (baseName === ".svgrrc") return "svgr";
  if (baseName.startsWith(".stylelintrc") || baseName === "stylelint.config.js")
    return "stylelint";
  if (baseName.startsWith("babel.config") || baseName === ".babelrc")
    return "babel";
  if (baseName.endsWith("rc") || baseName.includes("rc.")) return "rc";
  if (baseName.startsWith("webpack.config")) return "webpack";
  if (baseName.startsWith("vite.config")) return "vite";
  if (baseName.startsWith("vitest.config")) return "vitest";
  if (baseName.startsWith("jest.config")) return "jest";
  if (baseName.startsWith("cypress.config")) return "cypress";
  if (baseName.startsWith("playwright.config")) return "playwright";
  if (baseName === "tailwind.config.js" || baseName === "tailwind.config.ts")
    return "tailwind";
  if (baseName === "postcss.config.js" || baseName === "postcss.config.cjs")
    return "postcss";
  if (baseName === ".editorconfig") return "editorconfig";
  if (baseName === "readme.md" || baseName === "readme") return "readme";
  if (
    baseName === "license" ||
    baseName === "license.md" ||
    baseName === "license.txt"
  )
    return "license";
  if (baseName === ".env" || baseName.startsWith(".env.")) return "env";
  if (baseName === "prisma.schema" || baseName.endsWith(".prisma"))
    return "prisma";
  if (
    baseName === "schema.graphql" ||
    baseName.endsWith(".graphql") ||
    baseName.endsWith(".gql")
  )
    return "graphql";
  if (baseName === "tsconfig.json" || baseName === "jsconfig.json")
    return "config";
  if (baseName === "tauri.conf.json") return "tauri";
  if (baseName === "nuxt.config.js" || baseName === "nuxt.config.ts")
    return "nuxt";
  if (baseName === "gatsby-config.js" || baseName === "gatsby-node.js")
    return "gatsby";
  if (baseName === "firebase.json" || baseName === ".firebaserc")
    return "firebase";
  if (baseName === "vercel.json") return "vercel";
  if (baseName === "astro.config.mjs" || baseName === "astro.config.js")
    return "astro";

  // Test files
  if (lowerFileName.includes(".test.ts") || lowerFileName.includes(".spec.ts"))
    return "test-ts";
  if (lowerFileName.includes(".test.") || lowerFileName.includes(".spec."))
    return "test";

  // Config files
  if (lowerFileName.endsWith(".d.ts")) return "typescript-def";
  if (
    lowerFileName.includes(".config.") ||
    lowerFileName.includes("rc.") ||
    lowerFileName.endsWith("rc")
  ) {
    return "config";
  }

  // Extension-based matching
  return getFileTypeFromExtension(ext);
}

/**
 * Get file type from extension
 */
function getFileTypeFromExtension(ext: string): FileType {
  switch (ext) {
    // JavaScript/TypeScript ecosystem
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "jsx":
      return "jsx";
    case "tsx":
      return "tsx";
    case "vue":
      return "vue";
    case "svelte":
      return "svelte";
    case "astro":
      return "astro";

    // Markup/Style
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "sass":
      return "sass";
    case "less":
      return "less";
    case "styl":
    case "stylus":
      return "stylus";
    case "pcss":
      return "postcss";

    // Templating
    case "pug":
    case "jade":
      return "pug";
    case "haml":
      return "haml";
    case "ejs":
      return "ejs";
    case "hbs":
    case "handlebars":
      return "handlebars";
    case "jinja":
    case "jinja2":
    case "j2":
      return "jinja";
    case "twig":
      return "twig";

    // Data formats
    case "json":
    case "json5":
    case "jsonc":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
      return "xml";
    case "toml":
      return "toml";
    case "md":
    case "markdown":
      return "markdown";
    case "mdx":
      return "mdx";

    // Python
    case "py":
    case "pyw":
    case "pyi":
    case "pyx":
      return "python";
    case "ipynb":
      return "jupyter";

    // JVM languages
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "scala":
    case "sc":
      return "scala";
    case "groovy":
    case "gradle":
      return "groovy";
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return "clojure";

    // .NET
    case "cs":
      return "csharp";
    case "fs":
    case "fsi":
    case "fsx":
      return "fsharp";

    // C/C++
    case "c":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "c++":
      return "cpp";
    case "h":
      return "h";
    case "hpp":
    case "hxx":
    case "h++":
      return "hpp";
    case "m":
    case "mm":
      return "objective-c";
    case "cu":
    case "cuh":
      return "cuda";

    // Systems programming
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "zig":
      return "zig";
    case "nim":
    case "nims":
      return "nim";
    case "cr":
      return "crystal";
    case "d":
      return "d";
    case "v":
      return "vlang";
    case "vala":
    case "vapi":
      return "vala";

    // Web/Scripting
    case "php":
    case "php3":
    case "php4":
    case "php5":
    case "phtml":
      return "php";
    case "rb":
    case "rake":
    case "gemspec":
      return "ruby";
    case "lua":
      return "lua";
    case "pl":
    case "pm":
    case "pod":
      return "perl";
    case "coffee":
    case "litcoffee":
      return "coffee";

    // Shells
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
    case "bat":
    case "cmd":
      return "shell";
    case "ps1":
    case "psm1":
    case "psd1":
      return "powershell";

    // Functional languages
    case "hs":
    case "lhs":
      return "haskell";
    case "elm":
      return "elm";
    case "purs":
      return "purescript";
    case "ml":
    case "mli":
      return "ocaml";
    case "re":
    case "rei":
      return "reason";
    case "rkt":
      return "racket";
    case "scm":
    case "ss":
      return "scheme";
    case "lisp":
    case "lsp":
    case "cl":
      return "lisp";

    // Mobile
    case "swift":
      return "swift";
    case "dart":
      return "dart";

    // Data Science
    case "r":
    case "rdata":
    case "rds":
      return "r";
    case "jl":
      return "julia";
    case "mat":
      return "matlab";

    // Erlang/Elixir
    case "ex":
    case "exs":
      return "elixir";
    case "erl":
    case "hrl":
      return "erlang";

    // Database
    case "sql":
    case "psql":
    case "mysql":
    case "sqlite":
      return "sql";
    case "db":
    case "sqlite3":
      return "database";

    // Infrastructure
    case "tf":
    case "tfvars":
      return "terraform";
    case "hcl":
      return "hcl";
    case "proto":
    case "protobuf":
      return "proto";
    case "wasm":
    case "wat":
      return "wasm";
    case "sol":
      return "solidity";
    case "nix":
      return "nix";

    // Config files
    case "nginx":
    case "nginxconf":
      return "nginx";
    case "cmake":
      return "cmake";
    case "make":
    case "mk":
      return "makefile";
    case "pom":
      return "maven";

    // Version control
    case "patch":
    case "diff":
      return "diff";

    // Documents
    case "tex":
    case "latex":
    case "ltx":
      return "tex";
    case "pdf":
      return "pdf";
    case "doc":
    case "docx":
      return "word";
    case "xls":
    case "xlsx":
      return "excel";
    case "csv":
      return "document";
    case "ppt":
    case "pptx":
      return "powerpoint";
    case "pages":
      return "pages-doc";

    // Media
    case "svg":
      return "svg";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
    case "bmp":
    case "tiff":
    case "avif":
      return "image";
    case "mp4":
    case "webm":
    case "mov":
    case "avi":
    case "mkv":
    case "flv":
      return "video";
    case "mp3":
    case "wav":
    case "flac":
    case "ogg":
    case "aac":
    case "m4a":
      return "audio";
    case "ttf":
    case "otf":
    case "woff":
    case "woff2":
    case "eot":
      return "font";

    // Archives
    case "zip":
    case "tar":
    case "gz":
    case "bz2":
    case "xz":
    case "7z":
    case "rar":
      return "zip";

    // Other
    case "lock":
      return "lock";
    case "log":
      return "log";
    case "pem":
    case "crt":
    case "key":
    case "cer":
      return "key";
    case "exe":
    case "dll":
    case "so":
    case "dylib":
      return "exe";
    case "fig":
      return "figma";
    case "feature":
      return "cucumber";
    case "http":
    case "rest":
      return "http";
    case "applescript":
    case "scpt":
      return "applescript";
    case "ino":
      return "arduino";
    case "vim":
    case "vimrc":
      return "vim";
    case "pro":
      return "prolog";
    case "f":
    case "f90":
    case "f95":
    case "for":
      return "fortran";
    case "cob":
    case "cbl":
      return "cobol";
    case "asm":
    case "s":
      return "assembly";
    case "sv":
    case "svh":
    case "vh":
      return "verilog";
    case "hx":
    case "hxml":
      return "haxe";

    default:
      return "other";
  }
}
