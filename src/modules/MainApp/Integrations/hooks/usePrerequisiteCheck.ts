/**
 * usePrerequisiteCheck
 *
 * Checks whether a required binary is available on the user's system
 * using the cached dependency scan from the Rust backend.
 *
 * Returns { available: true } when no binary is required (null/undefined).
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";

import {
  depLookupAtom,
  ensureDepsLoadedAtom,
  invalidateDepsAtom,
} from "@src/store/platform/systemDepsAtom";

export interface PrerequisiteCheckResult {
  /** True if the binary is installed or no prerequisite is needed. */
  available: boolean;
  /** True while the dependency cache is being loaded for the first time. */
  loading: boolean;
  /** The binary being checked, or null if none required. */
  binary: string | null;
  /** Call after an install/uninstall to refresh the dependency data. */
  invalidate: () => void;
}

export function usePrerequisiteCheck(
  binary: string | null | undefined
): PrerequisiteCheckResult {
  const ensureLoaded = useSetAtom(ensureDepsLoadedAtom);
  const invalidate = useSetAtom(invalidateDepsAtom);
  const lookup = useAtomValue(depLookupAtom);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  const handleInvalidate = useCallback(() => {
    invalidate();
    ensureLoaded();
  }, [invalidate, ensureLoaded]);

  if (!binary) {
    return {
      available: true,
      loading: false,
      binary: null,
      invalidate: handleInvalidate,
    };
  }

  if (lookup.size === 0) {
    return {
      available: true,
      loading: true,
      binary,
      invalidate: handleInvalidate,
    };
  }

  const installed = lookup.get(binary);
  return {
    available: installed ?? false,
    loading: false,
    binary,
    invalidate: handleInvalidate,
  };
}
