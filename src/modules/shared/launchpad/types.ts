/**
 * Launchpad Types
 *
 * Types for repo detection, repo preview, and env var scanning.
 */

export const REPO_TYPES = {
  node: "Node.js",
  rust: "Rust",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  ruby: "Ruby",
  php: "PHP",
  dart: "Dart/Flutter",
  csharp: "C#/.NET",
  elixir: "Elixir",
  unknown: "Unknown",
} as const;

export type RepoType = keyof typeof REPO_TYPES;

export interface DetectedConfigFile {
  name: string;
  path: string;
}

export interface RepoDetectionResult {
  repoType: RepoType;
  repoTypeLabel: string;
  configFiles: DetectedConfigFile[];
  hasDocker: boolean;
  hasMakefile: boolean;
}

// ============================================
// Env Var Scanning
// ============================================

const SETUP_STATUS = {
  not_analyzed: "not_analyzed",
  no_env_config: "no_env_config",
  ready: "ready",
  params_missing: "params_missing",
} as const;

export type SetupStatus = keyof typeof SETUP_STATUS;

export interface EnvVar {
  key: string;
  value: string;
  source: "template" | "env";
  filled: boolean;
  comment?: string;
}

export interface EnvScanResult {
  status: SetupStatus;
  templateFile: string | null;
  vars: EnvVar[];
  filledCount: number;
  totalCount: number;
}

// ============================================
// Script Discovery
// ============================================

export const SCRIPT_CATEGORIES = {
  dev: "dev",
  build: "build",
  test: "test",
  lint: "lint",
  start: "start",
  other: "other",
} as const;

export type ScriptCategory = keyof typeof SCRIPT_CATEGORIES;

type ScriptSource =
  | "package.json"
  | "Makefile"
  | "Cargo.toml"
  | "pyproject.toml"
  | "go"
  | "pom.xml"
  | "build.gradle"
  | "build.gradle.kts"
  | "Gemfile"
  | "composer.json"
  | "pubspec.yaml"
  | "mix.exs"
  | "global.json"
  | "custom";

export interface RepoScript {
  name: string;
  command: string;
  category: ScriptCategory;
  source: ScriptSource;
}
