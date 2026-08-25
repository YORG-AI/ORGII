/**
 * Canonical frontend language metadata.
 *
 * A file extension can have different identifiers at different boundaries:
 * editor/LSP integrations, syntax highlighters, display labels, and icons.
 * Keep those dimensions explicit here rather than assuming one identifier works
 * for every consumer.
 */

export interface LanguageExtensionMetadata {
  extension: string;
  editorLanguageId?: string;
  syntaxHighlighterId?: string;
}

interface SpecialFilenameMetadata {
  name: string;
  detectedLanguageId: string;
}

export interface LanguageMetadata {
  id: string;
  displayName: string;
  iconFile?: string;
  /** Canonical Prism/refractor grammar when it differs from this metadata ID. */
  syntaxHighlighterId?: string;
  aliases?: readonly string[];
  extensions?: readonly LanguageExtensionMetadata[];
  filenames?: readonly SpecialFilenameMetadata[];
  filenamePrefixes?: readonly string[];
}

const extension = (
  extensionName: string,
  editorLanguageId?: string,
  syntaxHighlighterId?: string
): LanguageExtensionMetadata => ({
  extension: extensionName,
  editorLanguageId,
  syntaxHighlighterId,
});

export const LANGUAGE_METADATA: readonly LanguageMetadata[] = [
  {
    id: "javascript",
    displayName: "JavaScript",
    iconFile: "file.js",
    aliases: ["js"],
    extensions: [
      extension("js", "javascript", "javascript"),
      extension("mjs", "javascript"),
      extension("cjs", "javascript"),
    ],
  },
  {
    id: "javascriptreact",
    displayName: "JavaScript React",
    iconFile: "file.jsx",
    aliases: ["javascript react", "jsx"],
    extensions: [extension("jsx", "javascriptreact", "jsx")],
  },
  {
    id: "typescript",
    displayName: "TypeScript",
    iconFile: "file.ts",
    aliases: ["ts"],
    extensions: [extension("ts", "typescript", "typescript")],
  },
  {
    id: "typescriptreact",
    displayName: "TypeScript React",
    iconFile: "file.tsx",
    aliases: ["typescript react", "tsx"],
    extensions: [extension("tsx", "typescriptreact", "tsx")],
  },
  {
    id: "html",
    displayName: "HTML",
    iconFile: "file.html",
    extensions: [extension("html", "html"), extension("htm", "html")],
  },
  {
    id: "css",
    displayName: "CSS",
    iconFile: "file.css",
    extensions: [extension("css", "css", "css")],
  },
  {
    id: "scss",
    displayName: "SCSS",
    iconFile: "file.scss",
    extensions: [extension("scss", "scss", "scss")],
  },
  {
    id: "sass",
    displayName: "Sass",
    iconFile: "file.sass",
    extensions: [extension("sass", "sass")],
  },
  {
    id: "less",
    displayName: "Less",
    iconFile: "file.less",
    extensions: [extension("less", "less", "less")],
  },
  {
    id: "vue",
    displayName: "Vue",
    iconFile: "file.vue",
    extensions: [extension("vue", "vue")],
  },
  {
    id: "svelte",
    displayName: "Svelte",
    iconFile: "file.svelte",
    extensions: [extension("svelte", "svelte")],
  },
  {
    id: "python",
    displayName: "Python",
    iconFile: "file.py",
    aliases: ["py"],
    extensions: [
      extension("py", "python", "python"),
      extension("pyi", "python"),
    ],
  },
  {
    id: "ruby",
    displayName: "Ruby",
    iconFile: "file.rb",
    aliases: ["rb"],
    extensions: [extension("rb", "ruby", "ruby")],
  },
  {
    id: "php",
    displayName: "PHP",
    iconFile: "file.php",
    extensions: [extension("php", "php", "php")],
  },
  {
    id: "java",
    displayName: "Java",
    iconFile: "file.java",
    extensions: [extension("java", "java", "java")],
  },
  {
    id: "kotlin",
    displayName: "Kotlin",
    iconFile: "file.kt",
    extensions: [
      extension("kt", "kotlin", "kotlin"),
      extension("kts", "kotlin"),
    ],
  },
  {
    id: "scala",
    displayName: "Scala",
    iconFile: "file.scala",
    extensions: [extension("scala", "scala", "scala")],
  },
  {
    id: "go",
    displayName: "Go",
    iconFile: "file.go",
    aliases: ["golang"],
    extensions: [extension("go", "go", "go")],
  },
  {
    id: "rust",
    displayName: "Rust",
    iconFile: "file.rs",
    extensions: [extension("rs", "rust")],
  },
  {
    id: "c",
    displayName: "C",
    iconFile: "file.c",
    extensions: [extension("c", "c", "c")],
  },
  {
    id: "c-header",
    displayName: "C/C++ Header",
    iconFile: "file.hpp",
    aliases: ["c/c++ header"],
    extensions: [extension("h", "c", "cpp")],
  },
  {
    id: "cpp",
    displayName: "C++",
    iconFile: "file.cpp",
    aliases: ["c++"],
    extensions: [
      extension("cpp", "cpp", "cpp"),
      extension("cc", "cpp", "cpp"),
      extension("cxx", "cpp", "cpp"),
    ],
  },
  {
    id: "cpp-header",
    displayName: "C++ Header",
    iconFile: "file.hpp",
    syntaxHighlighterId: "cpp",
    extensions: [extension("hpp", "cpp"), extension("hxx", "cpp")],
  },
  {
    id: "csharp",
    displayName: "C#",
    iconFile: "file.cs",
    aliases: ["cs"],
    extensions: [extension("cs", "csharp", "csharp")],
  },
  {
    id: "swift",
    displayName: "Swift",
    iconFile: "file.swift",
    extensions: [extension("swift", "swift", "swift")],
  },
  {
    id: "objectivec",
    displayName: "Objective-C",
    aliases: ["objective-c"],
    extensions: [
      extension("m", "objectivec", "objectivec"),
      extension("mm", "objectivec"),
    ],
  },
  {
    id: "json",
    displayName: "JSON",
    iconFile: "file.json",
    extensions: [extension("json", "json", "json")],
    filenames: [
      { name: ".eslintrc", detectedLanguageId: "json" },
      { name: ".prettierrc", detectedLanguageId: "json" },
      { name: "tsconfig.json", detectedLanguageId: "json" },
      { name: "package.json", detectedLanguageId: "json" },
      { name: "composer.json", detectedLanguageId: "json" },
    ],
  },
  {
    id: "jsonc",
    displayName: "JSON with Comments",
    iconFile: "file.json",
    syntaxHighlighterId: "json",
    extensions: [extension("jsonc", "jsonc")],
  },
  {
    id: "yaml",
    displayName: "YAML",
    iconFile: "file.yaml",
    aliases: ["yml"],
    extensions: [extension("yaml", "yaml", "yaml"), extension("yml", "yaml")],
  },
  {
    id: "toml",
    displayName: "TOML",
    iconFile: "file.toml",
    extensions: [extension("toml", "toml", "toml")],
  },
  {
    id: "xml",
    displayName: "XML",
    iconFile: "file.xml",
    extensions: [extension("xml", "xml")],
  },
  {
    id: "markdown",
    displayName: "Markdown",
    iconFile: "file.md",
    aliases: ["md"],
    extensions: [
      extension("md", "markdown", "markdown"),
      extension("markdown"),
    ],
  },
  {
    id: "mdx",
    displayName: "MDX",
    syntaxHighlighterId: "markdown",
    extensions: [extension("mdx", "mdx")],
  },
  {
    id: "text",
    displayName: "Plain Text",
    iconFile: "file.txt",
    syntaxHighlighterId: "text",
    aliases: ["plain", "plaintext"],
    extensions: [extension("txt", "plaintext", "log")],
    filenames: [
      { name: ".gitignore", detectedLanguageId: "text" },
      { name: ".npmrc", detectedLanguageId: "text" },
    ],
  },
  {
    id: "shell",
    displayName: "Shell",
    iconFile: "file.sh",
    aliases: ["shellscript", "sh"],
    extensions: [extension("sh", "shellscript", "bash")],
  },
  {
    id: "bash",
    displayName: "Bash",
    iconFile: "file.sh",
    extensions: [extension("bash", "shellscript", "bash")],
    filenames: [{ name: ".bashrc", detectedLanguageId: "bash" }],
  },
  {
    id: "zsh",
    displayName: "Zsh",
    iconFile: "file.sh",
    syntaxHighlighterId: "bash",
    extensions: [extension("zsh", "shellscript")],
    filenames: [{ name: ".zshrc", detectedLanguageId: "zsh" }],
  },
  {
    id: "fish",
    displayName: "Fish",
    extensions: [extension("fish", "fish")],
  },
  {
    id: "powershell",
    displayName: "PowerShell",
    iconFile: "file.ps1",
    aliases: ["ps1"],
    extensions: [extension("ps1", "powershell", "powershell")],
  },
  {
    id: "sql",
    displayName: "SQL",
    iconFile: "file.sql",
    extensions: [extension("sql", "sql", "sql")],
  },
  {
    id: "dockerfile",
    displayName: "Dockerfile",
    iconFile: "Dockerfile",
    extensions: [extension("dockerfile", "dockerfile", "docker")],
    filenames: [{ name: "Dockerfile", detectedLanguageId: "dockerfile" }],
  },
  {
    id: "docker",
    displayName: "Docker",
    iconFile: "Dockerfile",
  },
  {
    id: "makefile",
    displayName: "Makefile",
    iconFile: "Makefile",
    extensions: [extension("makefile", "makefile", "makefile")],
    filenames: [{ name: "Makefile", detectedLanguageId: "makefile" }],
  },
  {
    id: "cmake",
    displayName: "CMake",
    extensions: [extension("cmake", "cmake", "cmake")],
  },
  {
    id: "hcl",
    displayName: "Terraform",
    iconFile: "file.tf",
    aliases: ["terraform"],
    extensions: [extension("tf", "hcl")],
  },
  {
    id: "graphql",
    displayName: "GraphQL",
    iconFile: "file.graphql",
    extensions: [
      extension("graphql", "graphql", "graphql"),
      extension("gql", "graphql"),
    ],
  },
  {
    id: "protobuf",
    displayName: "Protocol Buffers",
    extensions: [extension("proto", "protobuf", "protobuf")],
  },
  {
    id: "prisma",
    displayName: "Prisma",
    extensions: [extension("prisma", "prisma")],
  },
  {
    id: "haskell",
    displayName: "Haskell",
    iconFile: "file.hs",
    extensions: [extension("hs", "haskell", "haskell")],
  },
  {
    id: "elm",
    displayName: "Elm",
    extensions: [extension("elm", "elm", "elm")],
  },
  {
    id: "clojure",
    displayName: "Clojure",
    iconFile: "file.clj",
    extensions: [
      extension("clj", "clojure", "clojure"),
      extension("cljc", "clojure", "clojure"),
    ],
  },
  {
    id: "clojurescript",
    displayName: "ClojureScript",
    syntaxHighlighterId: "clojure",
    extensions: [extension("cljs", "clojurescript")],
  },
  {
    id: "ocaml",
    displayName: "OCaml",
    iconFile: "file.ml",
    extensions: [extension("ml", "ocaml", "ocaml"), extension("mli", "ocaml")],
  },
  {
    id: "elixir",
    displayName: "Elixir",
    iconFile: "file.ex",
    extensions: [
      extension("ex", "elixir", "elixir"),
      extension("exs", "elixir"),
    ],
  },
  {
    id: "erlang",
    displayName: "Erlang",
    iconFile: "file.erl",
    extensions: [extension("erl", "erlang", "erlang")],
  },
  {
    id: "lua",
    displayName: "Lua",
    iconFile: "file.lua",
    extensions: [extension("lua", "lua", "lua")],
  },
  {
    id: "perl",
    displayName: "Perl",
    extensions: [extension("perl", "perl"), extension("pl", "perl", "perl")],
  },
  {
    id: "r",
    displayName: "R",
    iconFile: "file.r",
    extensions: [extension("r", "r", "r")],
  },
  {
    id: "dart",
    displayName: "Dart",
    iconFile: "file.dart",
    extensions: [extension("dart", "dart", "dart")],
  },
  {
    id: "zig",
    displayName: "Zig",
    extensions: [extension("zig", "zig", "zig")],
  },
  {
    id: "vim",
    displayName: "Vim",
    extensions: [extension("vim", "vim", "vim")],
    filenames: [{ name: ".vimrc", detectedLanguageId: "vim" }],
  },
  {
    id: "ini",
    displayName: "INI",
    extensions: [extension("ini", undefined, "ini")],
  },
  {
    id: "shell-session",
    displayName: "Shell Session",
    syntaxHighlighterId: "shell-session",
    aliases: ["console"],
  },
  {
    id: "env",
    displayName: "Environment",
    extensions: [extension("env")],
    filenames: [{ name: ".env", detectedLanguageId: "env" }],
    filenamePrefixes: [".env"],
  },
  { id: "mysql", displayName: "MySQL" },
  { id: "postgresql", displayName: "PostgreSQL" },
  {
    id: "mongodb",
    displayName: "MongoDB",
    aliases: ["mongo"],
    extensions: [extension("mongo", undefined, "mongodb")],
  },
  {
    id: "tex",
    displayName: "TeX",
    extensions: [extension("tex", undefined, "latex")],
  },
  { id: "latex", displayName: "LaTeX" },
  { id: "nginx", displayName: "Nginx" },
  { id: "apache", displayName: "Apache" },
  { id: "astro", displayName: "Astro", iconFile: "file.astro" },
  {
    id: "diff",
    displayName: "Diff",
    extensions: [extension("diff", undefined, "diff")],
  },
  { id: "patch", displayName: "Patch", extensions: [extension("patch")] },
  { id: "default", displayName: "Code" },
] as const;

const EXTENSION_METADATA = new Map<
  string,
  { language: LanguageMetadata; extension: LanguageExtensionMetadata }
>();
const LANGUAGE_METADATA_BY_NAME = new Map<string, LanguageMetadata>();
const SPECIAL_FILENAME_METADATA = new Map<string, LanguageMetadata>();

for (const language of LANGUAGE_METADATA) {
  const names = [
    language.id,
    language.displayName,
    ...(language.aliases ?? []),
  ];
  for (const name of names) {
    LANGUAGE_METADATA_BY_NAME.set(name.toLowerCase(), language);
  }
  for (const extensionMetadata of language.extensions ?? []) {
    EXTENSION_METADATA.set(extensionMetadata.extension, {
      language,
      extension: extensionMetadata,
    });
    LANGUAGE_METADATA_BY_NAME.set(
      extensionMetadata.extension.toLowerCase(),
      language
    );
  }
  for (const filename of language.filenames ?? []) {
    SPECIAL_FILENAME_METADATA.set(filename.name, language);
  }
}

/** Compatibility map for editor/LSP consumers. Derived from the registry. */
export const LANGUAGE_MAP: Record<string, string> = Object.fromEntries(
  [...EXTENSION_METADATA.entries()].flatMap(([extensionName, metadata]) =>
    metadata.extension.editorLanguageId
      ? [[extensionName, metadata.extension.editorLanguageId]]
      : []
  )
);

/** Compatibility map for callers that need to inspect display aliases. */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> =
  Object.fromEntries(
    [...LANGUAGE_METADATA_BY_NAME.entries()].map(([name, metadata]) => [
      name,
      metadata.displayName,
    ])
  );

/** Compatibility map for raw code-block filename detection. */
export const SPECIAL_FILENAMES: Record<string, string> = Object.fromEntries(
  LANGUAGE_METADATA.flatMap((language) =>
    (language.filenames ?? []).map((filename) => [
      filename.name,
      filename.detectedLanguageId,
    ])
  )
);

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? "";
}

function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) return fileName.toLowerCase();
  return fileName.slice(lastDot + 1).toLowerCase();
}

export function getLanguageMetadata(
  language: string
): LanguageMetadata | undefined {
  return LANGUAGE_METADATA_BY_NAME.get(language.toLowerCase().trim());
}

export function getLanguageMetadataFromExtension(
  extensionName: string
): LanguageMetadata | undefined {
  const normalized = extensionName.replace(/^\./, "").toLowerCase();
  return EXTENSION_METADATA.get(normalized)?.language;
}

export function getLanguageMetadataFromPath(
  filePath: string | undefined | null
): LanguageMetadata | undefined {
  if (!filePath) return undefined;
  const fileName = getFileName(filePath);
  const exactMatch = SPECIAL_FILENAME_METADATA.get(fileName);
  if (exactMatch) return exactMatch;

  const lowerFileName = fileName.toLowerCase();
  const prefixMatch = LANGUAGE_METADATA.find((language) =>
    language.filenamePrefixes?.some((prefix) =>
      lowerFileName.startsWith(prefix.toLowerCase())
    )
  );
  if (prefixMatch) return prefixMatch;

  return EXTENSION_METADATA.get(getExtension(fileName))?.language;
}

export function getEditorLanguageFromExtension(
  extensionName: string,
  fallback?: string
): string | undefined {
  const normalized = extensionName.replace(/^\./, "").toLowerCase();
  return (
    EXTENSION_METADATA.get(normalized)?.extension.editorLanguageId ?? fallback
  );
}

export function getEditorLanguageFromPath(
  filePath: string | undefined | null,
  fallback?: string
): string | undefined {
  if (!filePath) return fallback;
  const fileName = getFileName(filePath);
  const extensionName = getExtension(fileName);
  return getEditorLanguageFromExtension(extensionName, fallback);
}

function getSyntaxHighlighterIdForMetadata(metadata: LanguageMetadata): string {
  return (
    metadata.syntaxHighlighterId ??
    metadata.extensions?.find((entry) => entry.syntaxHighlighterId)
      ?.syntaxHighlighterId ??
    metadata.id
  );
}

/**
 * Resolve an editor ID, extension, display alias, or legacy highlighter name
 * to the canonical Prism/refractor grammar owned by this registry.
 *
 * Unknown names are returned normalized so the registered-grammar boundary
 * can decide whether a directly supported Prism grammar exists.
 */
export function getSyntaxHighlighterLanguage(
  language: string | undefined
): string | undefined {
  if (!language) return undefined;
  const normalized = language.trim().toLowerCase();
  if (!normalized) return undefined;

  const extensionMetadata = EXTENSION_METADATA.get(normalized);
  if (extensionMetadata?.extension.syntaxHighlighterId) {
    return extensionMetadata.extension.syntaxHighlighterId;
  }

  const metadata =
    extensionMetadata?.language ?? LANGUAGE_METADATA_BY_NAME.get(normalized);
  return metadata ? getSyntaxHighlighterIdForMetadata(metadata) : normalized;
}

export function getSyntaxHighlighterLanguageFromPath(
  filePath: string
): string | undefined {
  if (!filePath) return undefined;
  const fileName = getFileName(filePath);
  const extensionMetadata = EXTENSION_METADATA.get(getExtension(fileName));
  if (extensionMetadata?.extension.syntaxHighlighterId) {
    return extensionMetadata.extension.syntaxHighlighterId;
  }

  const metadata = getLanguageMetadataFromPath(filePath);
  return metadata ? getSyntaxHighlighterIdForMetadata(metadata) : undefined;
}

export function getLanguageDisplayName(language: string): string {
  if (!language) return "Code";
  return getLanguageMetadata(language)?.displayName ?? language;
}

export function getLanguageDisplayNameFromPath(
  filePath: string | undefined | null,
  fallback = "Plain Text"
): string {
  return getLanguageMetadataFromPath(filePath)?.displayName ?? fallback;
}

export function getLanguageIconFile(language: string): string {
  if (!language) return "file.txt";
  return getLanguageMetadata(language)?.iconFile ?? "file.txt";
}
