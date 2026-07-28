/**
 * Classify journey files into produced results vs production-source touches.
 */

import type { JourneyFileCategory, WorkProductLike } from "./types";

const PRODUCED_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".html",
  ".htm",
  ".md",
  ".csv",
  ".xlsx",
  ".json",
  ".svg",
  ".mp4",
  ".webm",
]);

const PRODUCED_PATH_RE =
  /(^|\/)(dist|build|out|output|reports?|artifacts?|release|screenshots?|preview)(\/|$)/i;

const PRODUCED_NAME_RE =
  /(report|artifact|screenshot|preview|结果|报告|交付)/i;

const TOUCHED_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
  ".go",
  ".py",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".less",
  ".vue",
  ".svelte",
  ".sql",
  ".toml",
  ".yaml",
  ".yml",
  ".graphql",
  ".proto",
]);

const TOUCHED_PATH_RE =
  /(^|\/)(src|lib|app|packages|crates|services|backend|frontend|server|client)(\/|$)/i;

const PRODUCED_PRODUCT_TYPES = new Set([
  "screenshot",
  "document",
  "preview",
  "deployment",
  "validation",
  "risk_note",
]);

const TOUCHED_PRODUCT_TYPES = new Set(["file_change", "branch", "commit"]);

function extname(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx).toLowerCase();
}

export function classifyPath(path: string): JourneyFileCategory {
  const normalized = path.replace(/\\/g, "/");
  const ext = extname(normalized);
  const base = normalized.split("/").pop() ?? normalized;

  if (PRODUCED_PATH_RE.test(normalized) || PRODUCED_NAME_RE.test(base)) {
    return "produced";
  }
  if (PRODUCED_EXT.has(ext) && !TOUCHED_PATH_RE.test(normalized)) {
    return "produced";
  }
  if (TOUCHED_PATH_RE.test(normalized) || TOUCHED_EXT.has(ext)) {
    return "touched_production";
  }
  if (PRODUCED_EXT.has(ext)) return "produced";
  return "other";
}

export function classifyWorkProduct(
  product: WorkProductLike
): JourneyFileCategory {
  const type = (product.productType ?? product.type ?? "").toLowerCase();
  if (PRODUCED_PRODUCT_TYPES.has(type)) return "produced";
  if (TOUCHED_PRODUCT_TYPES.has(type)) return "touched_production";
  const path = product.path ?? product.uri ?? product.url ?? product.title ?? "";
  if (path) return classifyPath(path);
  return "other";
}

export function workProductPath(product: WorkProductLike): string | null {
  const raw =
    product.path ??
    product.uri ??
    product.url ??
    (typeof product.metadata?.path === "string"
      ? product.metadata.path
      : null) ??
    product.title ??
    null;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
