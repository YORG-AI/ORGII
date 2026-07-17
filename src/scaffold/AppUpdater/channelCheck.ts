import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";

import {
  resolveUpdateChannel,
  updateChannelPreferenceAtom,
} from "@src/store/platform/updateChannelAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

/**
 * Wire shape of the `check_app_update` Tauri command — mirrors the updater
 * plugin's own check response. `rid` is a live entry in the webview resource
 * table, so the plugin's `Update` class can drive download/install/close on
 * it unchanged.
 */
interface AppUpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
  rawJson: Record<string, unknown>;
}

/**
 * Channel-aware update check. The plugin's JS `check()` can only hit the
 * stable endpoint baked into tauri.conf.json; the Rust command rebuilds the
 * updater against the selected channel's manifest. The channel → URL map
 * stays in Rust so page code can never point the updater at arbitrary URLs.
 */
export async function checkAppUpdateOnChannel(
  timeoutMs: number
): Promise<Update | null> {
  const preference = getInstrumentedStore().get(updateChannelPreferenceAtom);
  const currentVersion = await getVersion().catch(() => undefined);
  const channel = resolveUpdateChannel(preference, currentVersion);

  const metadata = await invoke<AppUpdateMetadata | null>("check_app_update", {
    channel,
    timeoutMs,
  });
  if (!metadata) return null;

  return new Update({
    ...metadata,
    date: metadata.date ?? undefined,
    body: metadata.body ?? undefined,
  });
}
