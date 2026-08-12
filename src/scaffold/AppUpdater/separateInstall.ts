import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export interface SeparateAppUpdateInstallResult {
  targetPath: string;
  version: string;
}

export async function installAppUpdateSeparately(
  update: Update,
  onEvent?: (event: DownloadEvent) => void
): Promise<SeparateAppUpdateInstallResult> {
  const channel = new Channel<DownloadEvent>();
  if (onEvent) channel.onmessage = onEvent;

  return invoke<SeparateAppUpdateInstallResult>(
    "install_app_update_separately",
    {
      updateRid: update.rid,
      onEvent: channel,
    }
  );
}
