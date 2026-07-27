import { invoke } from "@tauri-apps/api/core";

import {
  type Org2CloudAuthState,
  parseStoredOrg2CloudAuth,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";

/**
 * Read the installed app's bundled-origin login through the narrow native
 * debug bridge. `null` is an authoritative "the bundled app is signed out".
 */
export async function importBundledOrg2CloudAuthForDev(): Promise<Org2CloudAuthState | null> {
  const raw = await invoke<string | null>(
    "debug_import_bundled_org2_cloud_auth"
  );
  return parseStoredOrg2CloudAuth(raw);
}
