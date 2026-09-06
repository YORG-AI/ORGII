/**
 * Ignore Patterns Configuration
 *
 * Default patterns and parser for .orgiiignore files.
 * Used by search and indexing to exclude files/directories.
 */

// ============================================
// Types
// ============================================

export interface IgnorePattern {
  pattern: string;
  negated: boolean; // Patterns starting with ! are negations
  isDirectory: boolean; // Patterns ending with / match directories only
}

// ============================================
// Default Patterns
// ============================================

/**
 * Default patterns applied when no .orgiiignore file exists.
 * Based on common development patterns.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  // Package managers
  "node_modules/",
  ".pnpm/",
  "vendor/",

  // Version control
  ".git/",
  ".svn/",
  ".hg/",

  // Build outputs
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".output/",
  "target/", // Rust

  // Cache directories
  ".cache/",
  ".parcel-cache/",
  ".turbo/",

  // IDE/Editor
  ".idea/",
  ".vscode/",
  "*.swp",
  "*.swo",

  // Lock files (large, not useful for search)
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",

  // Minified/bundled files
  "*.min.js",
  "*.min.css",
  "*.bundle.js",
  "*.map",

  // Environment files (sensitive)
  ".env",
  ".env.*",
  "*.env",

  // Logs
  "*.log",
  "logs/",

  // OS files
  ".DS_Store",
  "Thumbs.db",

  // Test coverage
  "coverage/",
  ".nyc_output/",

  // Temporary files
  "tmp/",
  "temp/",
  "*.tmp",
];

// ============================================
// Parser
// ============================================

/**
 * Parse a single line from .orgiiignore file
 */
function parseLine(line: string): IgnorePattern | null {
  // Trim whitespace
  let trimmed = line.trim();

  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  // Check for negation (!)
  const negated = trimmed.startsWith("!");
  if (negated) {
    trimmed = trimmed.slice(1);
  }

  // Check if it's a directory pattern
  const isDirectory = trimmed.endsWith("/");

  return {
    pattern: trimmed,
    negated,
    isDirectory,
  };
}

/**
 * Parse .orgiiignore file content into patterns
 */
export function parseIgnoreFile(content: string): IgnorePattern[] {
  return content
    .split("\n")
    .map(parseLine)
    .filter((pattern): pattern is IgnorePattern => pattern !== null);
}

/**
 * Convert string patterns to IgnorePattern objects
 */
export function patternsFromStrings(patterns: string[]): IgnorePattern[] {
  return patterns
    .map(parseLine)
    .filter((pattern): pattern is IgnorePattern => pattern !== null);
}

/**
 * Get default patterns as IgnorePattern objects
 */
export function getDefaultPatterns(): IgnorePattern[] {
  return patternsFromStrings(DEFAULT_IGNORE_PATTERNS);
}

// ============================================
// Matchers
// ============================================

/**
 * Convert glob pattern to regex
 * Supports: *, **, ?, [abc], [!abc]
 */
function patternToRegex(pattern: string): RegExp {
  let regexStr = pattern
    // Escape special regex chars (except our glob chars)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** matches any path segment
    .replace(/\*\*/g, "{{DOUBLE_STAR}}")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // Restore ** as .*
    .replace(/{{DOUBLE_STAR}}/g, ".*")
    // ? matches single char except /
    .replace(/\?/g, "[^/]");

  // If pattern doesn't start with /, it can match anywhere in path
  if (!pattern.startsWith("/")) {
    regexStr = "(^|/)" + regexStr;
  } else {
    regexStr = "^" + regexStr.slice(1); // Remove leading /
  }

  // If pattern ends with /, only match directories (append .* to match contents)
  if (pattern.endsWith("/")) {
    regexStr = regexStr.slice(0, -1) + "(/.*)?$";
  } else {
    regexStr += "(/.*)?$";
  }

  return new RegExp(regexStr);
}

/**
 * Check if a path matches an ignore pattern
 */
export function matchesPattern(path: string, pattern: IgnorePattern): boolean {
  const regex = patternToRegex(pattern.pattern);
  return regex.test(path);
}

/**
 * Check if a path should be ignored based on patterns
 * Returns true if the path should be IGNORED
 */
export function shouldIgnore(path: string, patterns: IgnorePattern[]): boolean {
  let ignored = false;

  for (const pattern of patterns) {
    if (matchesPattern(path, pattern)) {
      // Negated patterns un-ignore, regular patterns ignore
      ignored = !pattern.negated;
    }
  }

  return ignored;
}

/**
 * Filter an array of paths, removing ignored ones
 */
export function filterIgnoredPaths(
  paths: string[],
  patterns: IgnorePattern[]
): string[] {
  return paths.filter((path) => !shouldIgnore(path, patterns));
}
