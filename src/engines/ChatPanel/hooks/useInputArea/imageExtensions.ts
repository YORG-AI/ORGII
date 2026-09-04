/**
 * Shared image-extension classifier used by every chat-input image entry point
 * (paste, file-picker, drag-drop) so they agree on what counts as an image.
 *
 * Kept next to `useImageAttachment` since that hook is the canonical consumer.
 * Intentionally a small data-only module — no React deps — so other hooks
 * (e.g. `useFileUpload` on the SessionCreator surface) can import it too.
 */

export const IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".svg",
] as const;

const CHAT_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

function normalizeMimeType(type: string): string {
  const base = type.trim().toLowerCase().split(";")[0];
  return base === "image/jpg" ? "image/jpeg" : base;
}

function mimeFromFileName(name: string): string | undefined {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return undefined;
  return EXTENSION_MIME[match[1]];
}

/**
 * Return true if `name` ends with one of the recognized image extensions.
 * Case-insensitive.
 */
export function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Resolve a chat-ingestible image MIME type from browser metadata.
 * Mobile gallery pickers often omit `file.type` or use HEIC.
 */
export function resolveChatImageMimeType(file: File): string | null {
  if (file.type.trim()) {
    const normalized = normalizeMimeType(file.type);
    if (CHAT_IMAGE_MIME_TYPES.has(normalized)) {
      return normalized;
    }
  }

  const fromName = mimeFromFileName(file.name);
  if (fromName) {
    return fromName;
  }

  return null;
}

export function isChatImageFile(file: File): boolean {
  return resolveChatImageMimeType(file) !== null;
}

/**
 * Normalize a picked `File` so downstream optimizers see a stable MIME type.
 */
export function prepareChatImageFile(file: File): File | null {
  const mime = resolveChatImageMimeType(file);
  if (!mime) return null;
  if (normalizeMimeType(file.type) === mime) {
    return file;
  }
  return new File([file], file.name || "photo.jpg", {
    type: mime,
    lastModified: file.lastModified,
  });
}
