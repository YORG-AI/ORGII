/**
 * useAvailableShells
 *
 * Fetches detected shells from the Rust backend via `detect_available_shells`
 * and converts them into `ShellProfile` objects for the profile picker.
 *
 * Results are cached after the first successful fetch — the set of available
 * shells doesn't change during a single app session.
 */
import { useCallback } from "react";

import { useAsyncResource } from "@src/hooks/async";
import type { DetectedShell, ShellProfile } from "@src/types/terminal";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

interface UseAvailableShellsReturn {
  profiles: ShellProfile[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

let cachedProfiles: ShellProfile[] | null = null;
const EMPTY_SHELL_PROFILES: ShellProfile[] = [];

function detectedShellToProfile(shell: DetectedShell): ShellProfile {
  return {
    id: `${shell.kind}-${shell.path.replace(/[^a-zA-Z0-9]/g, "-")}`,
    name: shell.name,
    path: shell.path,
    args: shell.default_args,
    kind: shell.kind,
    category: shell.category,
    isDefault: shell.is_default,
    isCustom: false,
  };
}

export function useAvailableShells(): UseAvailableShellsReturn {
  const fetchShells = useCallback(async () => {
    if (cachedProfiles) return cachedProfiles;
    if (!isTauriReady()) return EMPTY_SHELL_PROFILES;
    const detected = await invokeTauri<DetectedShell[]>(
      "detect_available_shells"
    );
    cachedProfiles = detected.map(detectedShellToProfile);
    return cachedProfiles;
  }, []);
  const resource = useAsyncResource({
    fetcher: fetchShells,
    initialData: cachedProfiles ?? EMPTY_SHELL_PROFILES,
    initialStatus: cachedProfiles ? "ready" : "idle",
    scopeKey: "available-shells",
  });
  const refreshResource = resource.refresh;

  const refresh = useCallback(() => {
    cachedProfiles = null;
    void refreshResource();
  }, [refreshResource]);

  return {
    profiles: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh,
  };
}
