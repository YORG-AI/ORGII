/**
 * Project asset (binary attachment) commands.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Save a binary asset under `projects/{slug}/assets/{filename}`.
 * `base64Data` must be the bare base64 (no `data:` URL prefix).
 * Returns the relative path the frontend embeds in markdown.
 */
export async function saveAsset(
  projectSlug: string,
  filename: string,
  base64Data: string
): Promise<string> {
  return invoke("project_save_asset", {
    projectSlug,
    filename,
    base64Data,
  });
}

export async function deleteAsset(
  projectSlug: string,
  filename: string
): Promise<void> {
  return invoke("project_delete_asset", { projectSlug, filename });
}

export async function listAssets(projectSlug: string): Promise<string[]> {
  return invoke("project_list_assets", { projectSlug });
}

export async function resolveAssetPath(
  projectSlug: string,
  filename: string
): Promise<string> {
  return invoke("project_resolve_asset_path", { projectSlug, filename });
}
