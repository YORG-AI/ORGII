/**
 * Binary Detection API — SIMD-accelerated binary file detection.
 * 10-20x faster than JS for content analysis.
 */
import { invoke } from "@tauri-apps/api/core";

import type { BinaryCheckResult } from "./types";

// ============================================
// Rust-backed API
// ============================================

export async function checkBinaryByPath(path: string): Promise<boolean | null> {
  return invoke<boolean | null>("check_binary_by_path", { path });
}

// ============================================
// Enhanced Detection with Magic Bytes (infer)
// ============================================

/**
 * Check if content bytes are binary using enhanced detection.
 *
 * Detection order:
 * 1. Magic bytes (infer crate) — most reliable for known file types
 * 2. SIMD null byte scan — fast binary indicator
 * 3. Non-printable character ratio — heuristic fallback
 *
 * @param content Content as Uint8Array
 * @param sampleSize Bytes to sample (default: 8000)
 * @returns Binary check result with reason
 */
export async function checkBinaryContentEnhanced(
  content: Uint8Array,
  sampleSize?: number
): Promise<BinaryCheckResult> {
  return invoke<BinaryCheckResult>("check_binary_content_enhanced", {
    content: Array.from(content),
    sampleSize,
  });
}

/**
 * Full binary file check using enhanced detection.
 *
 * Uses magic bytes for most reliable detection, then falls back to
 * extension and content analysis.
 *
 * @param path File path to check
 * @param sampleSize Bytes to sample (default: 8000)
 * @returns Binary check result
 */
export async function checkFileIsBinaryEnhanced(
  path: string,
  sampleSize?: number
): Promise<BinaryCheckResult> {
  return invoke<BinaryCheckResult>("check_file_is_binary_enhanced", {
    path,
    sampleSize,
  });
}
