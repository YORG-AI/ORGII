/**
 * Diff algorithm — delegates to Rust `similar` crate via Tauri IPC.
 * Replaces the O(n^2) JS LCS implementation.
 */
import { invoke } from "@tauri-apps/api/core";

import type { AlignedLine } from "../types";

/**
 * Compute aligned diff between old and new content using Rust.
 */
export async function computeAlignedDiffAsync(
  oldValue: string,
  newValue: string
): Promise<AlignedLine[]> {
  return invoke("compute_aligned_diff", {
    oldText: oldValue,
    newText: newValue,
  });
}
