/**
 * Background Image Storage Utility
 *
 * Stores custom background images in ~/.orgii/backgrounds/
 * Since we only ship as Tauri app, we always use filesystem storage.
 */
import { createLogger } from "@src/hooks/logger";

const log = createLogger("BackgroundImage");

// Constants
const BACKGROUNDS_FOLDER = "backgrounds";
const METADATA_KEY = "orgii_background_metadata";

// Type definitions
interface ImageMetadata {
  id: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
}

type MetadataStore = Record<string, ImageMetadata>;

/**
 * Get the backgrounds directory path
 * Uses the Tauri app data directory (e.g. ~/Library/Application Support/org2ai.org2/backgrounds/).
 * This is consistent with other app data (semantic index, etc.)
 */
async function getBackgroundsPath(): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const dataDir = await appDataDir();
  return join(dataDir, BACKGROUNDS_FOLDER);
}

/**
 * Ensure the backgrounds directory exists
 */
async function ensureBackgroundsDir(): Promise<string> {
  const { mkdir } = await import("@tauri-apps/plugin-fs");
  const path = await getBackgroundsPath();

  try {
    await mkdir(path, { recursive: true });
  } catch {
    // Directory might already exist
  }

  return path;
}

/**
 * Convert base64 data URL to Uint8Array
 */
function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    array[index] = binary.charCodeAt(index);
  }
  return array;
}

/**
 * Convert Uint8Array to base64 data URL
 */
function uint8ArrayToDataUrl(uint8Array: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let index = 0; index < uint8Array.length; index++) {
    binary += String.fromCharCode(uint8Array[index]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Get MIME type from data URL
 */
function getMimeType(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;]+);/);
  return match ? match[1] : "image/png";
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mimeType] || "png";
}

/**
 * Get stored metadata from localStorage
 */
function getStoredMetadata(): MetadataStore {
  try {
    const stored = localStorage.getItem(METADATA_KEY);
    return stored ? (JSON.parse(stored) as MetadataStore) : {};
  } catch {
    return {};
  }
}

/**
 * Save metadata to localStorage
 */
function saveMetadata(metadata: MetadataStore): void {
  localStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
}

/**
 * Save a background image to ~/.orgii/backgrounds/
 * @param dataUrl - Base64 encoded image data URL
 * @returns Image ID or null on failure
 */
export async function saveBackgroundImage(
  dataUrl: string
): Promise<string | null> {
  try {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const imageId = `bg_${Date.now()}`;
    const mimeType = getMimeType(dataUrl);
    const extension = getExtensionFromMimeType(mimeType);
    const fileName = `${imageId}.${extension}`;

    const backgroundsPath = await ensureBackgroundsDir();
    const filePath = await join(backgroundsPath, fileName);

    // Convert data URL to binary and write
    const uint8Array = dataUrlToUint8Array(dataUrl);
    await writeFile(filePath, uint8Array);

    // Save metadata
    const metadata = getStoredMetadata();
    metadata[imageId] = {
      id: imageId,
      fileName,
      mimeType,
      createdAt: new Date().toISOString(),
    };
    saveMetadata(metadata);
    return imageId;
  } catch (error) {
    log.error("[BackgroundImage] Failed to save:", error);
    return null;
  }
}

/**
 * Load a background image by ID (returns data URL)
 * @param imageId - Image ID
 * @returns Data URL or null if not found
 */
export async function loadBackgroundImage(
  imageId: string
): Promise<string | null> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const metadata = getStoredMetadata();
    const imageMeta = metadata[imageId];

    if (!imageMeta) {
      log.warn(`Metadata not found for: ${imageId}`);
      return null;
    }

    const backgroundsPath = await getBackgroundsPath();
    const filePath = await join(backgroundsPath, imageMeta.fileName);

    // Read binary file
    const uint8Array = await readFile(filePath);

    // Convert to data URL
    return uint8ArrayToDataUrl(uint8Array, imageMeta.mimeType);
  } catch (error) {
    log.error(`Failed to load ${imageId}:`, error);
    return null;
  }
}

/**
 * Load a background image by ID as a Blob URL
 *
 * PERFORMANCE: Uses URL.createObjectURL(Blob) instead of data URL conversion.
 * This is O(1) — it creates a URL reference to the binary data directly,
 * avoiding the expensive string concatenation + btoa() base64 encoding.
 *
 * For a 750KB image: data URL takes ~50-200ms, blob URL takes <1ms.
 *
 * @param imageId - Image ID
 * @returns Blob URL (blob:http://...) or null if not found
 */
export async function loadBackgroundImageAsBlob(
  imageId: string
): Promise<string | null> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const metadata = getStoredMetadata();
    const imageMeta = metadata[imageId];

    if (!imageMeta) {
      log.warn(`Metadata not found for: ${imageId}`);
      return null;
    }

    const backgroundsPath = await getBackgroundsPath();
    const filePath = await join(backgroundsPath, imageMeta.fileName);

    // Read binary file
    const uint8Array = await readFile(filePath);

    // Create blob URL — O(1), no base64 conversion needed
    const blob = new Blob([uint8Array], { type: imageMeta.mimeType });
    return URL.createObjectURL(blob);
  } catch (error) {
    log.error(`Failed to load ${imageId}:`, error);
    return null;
  }
}

/**
 * Delete a background image
 * @param imageId - Image ID
 * @returns True on success, false on failure
 */
export async function deleteBackgroundImage(imageId: string): Promise<boolean> {
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");

    const metadata = getStoredMetadata();
    const imageMeta = metadata[imageId];

    if (imageMeta) {
      const backgroundsPath = await getBackgroundsPath();
      const filePath = await join(backgroundsPath, imageMeta.fileName);

      try {
        await remove(filePath);
      } catch {
        // File might not exist, continue to clean up metadata
      }

      delete metadata[imageId];
      saveMetadata(metadata);
    }

    return true;
  } catch (error) {
    log.error(`Failed to delete ${imageId}:`, error);
    return false;
  }
}

/**
 * List all stored background image IDs
 * @returns Array of image IDs
 */
export async function listBackgroundImages(): Promise<string[]> {
  const metadata = getStoredMetadata();
  return Object.keys(metadata);
}

/**
 * Get storage information
 */
export async function getStorageInfo(): Promise<{
  storageType: "filesystem";
  path: string;
  imageCount: number;
  used: number;
  quota: number;
}> {
  const path = await getBackgroundsPath();
  const imageIds = await listBackgroundImages();

  return {
    storageType: "filesystem",
    path,
    imageCount: imageIds.length,
    // Filesystem has no practical quota limit
    used: 0,
    quota: Infinity,
  };
}

/**
 * Migrate old base64 images to storage
 * @param dataUrls - Array of base64 data URLs to migrate
 * @returns Array of image IDs for the migrated images
 */
export async function migrateImagesToStorage(
  dataUrls: string[]
): Promise<string[]> {
  const imageIds: string[] = [];

  for (const dataUrl of dataUrls) {
    const imageId = await saveBackgroundImage(dataUrl);
    if (imageId) {
      imageIds.push(imageId);
    }
  }
  return imageIds;
}

/**
 * Debug helper: Log current storage configuration
 */
export async function debugBackgroundStorage() {
  const info = await getStorageInfo();

  log.debug("🖼️ Background Image Storage");

  return info;
}

// Expose debug helper to window
if (typeof window !== "undefined") {
  (
    window as { debugBackgroundStorage?: typeof debugBackgroundStorage }
  ).debugBackgroundStorage = debugBackgroundStorage;
}
