/**
 * Shared display helpers for external data-source on-disk paths.
 *
 * Lifted out of RuntimeDataSourcePanel so the row cells and the expanded
 * DataSourceDetailsCard format store paths + kinds identically.
 */
import type { ExternalCliSourceProbe } from "@src/api/tauri/externalHistory";

/** Human labels for the on-disk store format ORGII parses. */
export const STORE_KIND_LABELS: Record<string, string> = {
  jsonl: "JSONL",
  sqlite: "SQLite",
  json: "JSON",
  markdown: "Markdown",
};

/** Collapse an absolute home path to a leading `~/` for display. */
export function tildePath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)\//, "~/");
}

/** Display label for a source's store format, e.g. "JSONL" (empty when unknown). */
export function storeKindLabel(probe: ExternalCliSourceProbe): string {
  return STORE_KIND_LABELS[probe.storeKind] ?? probe.storeKind;
}
