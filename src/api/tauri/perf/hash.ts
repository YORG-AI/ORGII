/**
 * Hash API — SHA-256 and Blake3 hashing via Rust.
 */
import { invoke } from "@tauri-apps/api/core";

import type { HashResult } from "./types";

export async function computeFileHash(
  path: string,
  algorithm?: "sha256" | "blake3"
): Promise<HashResult> {
  return invoke<HashResult>("compute_file_hash", { path, algorithm });
}
