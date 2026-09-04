/**
 * Token Atoms - Shared state for scanned design tokens
 */
import { atom } from "jotai";

// ============================================
// Types
// ============================================

export interface TokenDefinition {
  /** Token name (without -- prefix) */
  name: string;
  /** Token value */
  value: string;
  /** Source file path */
  source: string;
}

// ============================================
// Atoms
// ============================================

/**
 * All scanned tokens from the repo
 */
export const scannedTokensAtom = atom<TokenDefinition[]>([]);
