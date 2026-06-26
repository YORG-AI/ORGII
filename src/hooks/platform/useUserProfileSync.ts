/**
 * User Profile Sync Hook
 *
 * Mirrors Settings → My Role into Rust process state so backend-only and
 * background turns can still render the User Profile prompt section when they
 * do not have a frontend-collected IdeContext payload.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";
import { buildUserProfileWire } from "@src/services/context/collectors/AdeContextCollector";
import { settingsAtom } from "@src/store/settings";

const log = createLogger("UserProfileSync");

export function useUserProfileSync() {
  const settings = useAtomValue(settingsAtom);
  const profile = useMemo(() => buildUserProfileWire(settings), [settings]);

  useEffect(() => {
    invoke("set_user_profile", { profile: profile ?? null }).catch((error) => {
      log.error("[UserProfileSync] Failed to push profile:", error);
    });
  }, [profile]);
}
