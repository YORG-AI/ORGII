/**
 * Minimal static import-graph walker for bundle-boundary regression tests.
 *
 * Follows `import … from`, `export … from`, and bare `import "…"` edges
 * across `src/` files, resolving `@src/`, `@/src/`, and relative specifiers.
 * Deliberately IGNORES:
 *   - `import type` / `export type` (erased by TypeScript),
 *   - dynamic `import(...)` (a lazy chunk boundary),
 *   - anything under node_modules (recorded as an external package name).
 *
 * It is not a full module resolver — it is fast (regex-based, milliseconds
 * over thousands of files) and good enough to assert "module X is not
 * statically reachable from entry Y", which is what keeps heavy libraries out
 * of the startup graph and React renderers out of the worker graph.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SRC_ROOT = path.resolve(__dirname, "..");

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the statement is a type-only import/export (erased at build). */
function isTypeOnlyStatement(statement: string): boolean {
  return /^\s*(?:import|export)\s+type\s/.test(statement);
}

function resolveWithExtensions(base: string): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of EXTENSIONS) {
      const candidate = path.join(base, `index${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  return null;
}

/** Resolve a specifier to an absolute src file, or null for externals. */
export function resolveSpecifier(
  specifier: string,
  fromFile: string
): string | null {
  let base: string;
  if (specifier.startsWith("@src/")) {
    base = path.join(SRC_ROOT, specifier.slice("@src/".length));
  } else if (specifier.startsWith("@/src/")) {
    base = path.join(SRC_ROOT, specifier.slice("@/src/".length));
  } else if (specifier.startsWith("@/")) {
    // `@/*` maps to the repo root; anything outside src/ is external.
    base = path.join(SRC_ROOT, "..", specifier.slice("@/".length));
    if (!base.startsWith(SRC_ROOT + path.sep)) return null;
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  // Strip webpack resource queries (`?raw`, `?url`).
  base = base.replace(/\?.*$/, "");
  return resolveWithExtensions(base);
}

export interface StaticImportGraph {
  /** Absolute paths of every statically reachable src file (incl. entries). */
  files: Set<string>;
  /** Bare package specifiers imported anywhere in the reachable set. */
  packages: Set<string>;
  /** Parent pointer for `explain()`. */
  parent: Map<string, string>;
  /** Human-readable import chain from an entry to `file`. */
  explain(file: string): string;
}

/** Package name from a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function walkStaticImports(
  entryFiles: readonly string[]
): StaticImportGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const entry of entryFiles) {
    const abs = path.isAbsolute(entry) ? entry : path.join(SRC_ROOT, entry);
    files.add(abs);
    queue.push(abs);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(file)) continue;
    let source: string;
    try {
      source = stripComments(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      if (isTypeOnlyStatement(match[0])) continue;
      const specifier = match[1];
      const resolved = resolveSpecifier(specifier, file);
      if (resolved === null) {
        // Style/asset imports are not packages either.
        if (/^[a-zA-Z@]/.test(specifier))
          packages.add(packageNameOf(specifier));
        continue;
      }
      if (/\.(s?css|svg|png|jpe?g|gif|webp|mp4|json)$/.test(resolved)) continue;
      if (!files.has(resolved)) {
        files.add(resolved);
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }
  const rel = (f: string) => path.relative(SRC_ROOT, f);
  return {
    files,
    packages,
    parent,
    explain(file: string): string {
      const abs = path.isAbsolute(file) ? file : path.join(SRC_ROOT, file);
      const chain = [rel(abs)];
      let cursor = abs;
      while (parent.has(cursor)) {
        cursor = parent.get(cursor)!;
        chain.push(rel(cursor));
      }
      return chain.join("  <-  ");
    },
  };
}

/** Relative (to src/) paths of reachable files matching `pattern`. */
export function reachableFilesMatching(
  graph: StaticImportGraph,
  pattern: RegExp
): string[] {
  return [...graph.files]
    .map((f) => path.relative(SRC_ROOT, f))
    .filter((f) => pattern.test(f))
    .sort();
}

/** Files in the reachable set that import a given package (for diagnostics). */
export function importersOfPackage(
  graph: StaticImportGraph,
  packageName: string
): string[] {
  const out: string[] = [];
  for (const file of graph.files) {
    let source: string;
    try {
      source = stripComments(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      if (isTypeOnlyStatement(match[0])) continue;
      if (
        packageNameOf(match[1]) === packageName &&
        !match[1].startsWith(".")
      ) {
        out.push(graph.explain(file));
        break;
      }
    }
  }
  return out;
}
