/**
 * File path extraction utilities for GlobalDragDrop
 *
 * Contains multiple strategies for extracting file paths from drag events
 */

export interface ExtractedFilePath {
  filePath: string;
  fileName: string;
}

/**
 * Extract file path from drag event using multiple strategies
 * Returns null if no path could be extracted
 */
export function extractFilePath(
  dataTransfer: DataTransfer | null
): ExtractedFilePath | null {
  if (!dataTransfer) return null;

  const rawTypes = dataTransfer.types;
  const types = rawTypes ? Array.from(rawTypes) : [];
  const items = Array.from(dataTransfer.items);
  // Log all available data
  for (const type of types) {
    try {
      const _data = dataTransfer.getData(type);
      // Data retrieved for debugging purposes
    } catch (_err) {
      // Ignore errors when reading data types
    }
  }

  // Get all text data formats
  const plainText = dataTransfer.getData("text/plain") || "";
  const uriList = dataTransfer.getData("text/uri-list") || "";
  const textData = dataTransfer.getData("text") || "";
  const htmlData = dataTransfer.getData("text/html") || "";
  let filePath: string | null = null;

  // Strategy 1: file:// or vscode:// URI in uri-list
  filePath = extractFromUriList(uriList);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }

  // Strategy 2: file:// or vscode:// URI in plain text
  filePath = extractFromPlainText(plainText);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }

  // Strategy 3: Plain file path starting with / (Unix) or drive letter (Windows)
  filePath = extractPlainPath(plainText);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }

  // Strategy 4: Check text data
  filePath = extractFromTextData(textData);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }

  // Strategy 5: Extract from HTML (VS Code sometimes puts path in HTML)
  filePath = extractFromHtml(htmlData);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }

  // Strategy 6: File items from dataTransfer
  filePath = extractFromFileItems(items);
  if (filePath) {
    return normalizeAndReturn(filePath);
  }
  return null;
}

/**
 * Strategy 7: Async extraction from string items
 * This must be called separately as it's async
 */
export async function extractFilePathAsync(
  items: DataTransferItem[]
): Promise<ExtractedFilePath | null> {
  const stringItems = items.filter((item) => item.kind === "string");

  for (const item of stringItems) {
    const str = await new Promise<string>((resolve) => {
      item.getAsString((pathStr) => resolve(pathStr || ""));
    });
    if (str) {
      let extractedPath: string | null = null;

      if (str.includes("file://")) {
        extractedPath = str
          .replace("file://", "")
          .split("\n")[0]
          .split("\r")[0];
      } else if (str.startsWith("/") || /^[A-Za-z]:/.test(str)) {
        extractedPath = str.split("\n")[0].split("\r")[0];
      }

      if (extractedPath) {
        try {
          extractedPath = decodeURIComponent(extractedPath);
        } catch {
          // ignore decode errors
        }
        extractedPath = extractedPath.split("?")[0].trim();
        const fileName = extractedPath.split("/").pop() || extractedPath;
        return { filePath: extractedPath, fileName };
      }
    }
  }

  return null;
}

// Helper functions for each strategy

function extractFromUriList(uriList: string): string | null {
  if (!uriList) return null;

  if (uriList.includes("file://")) {
    return uriList.replace("file://", "").split("\n")[0].split("\r")[0];
  } else if (uriList.includes("vscode://")) {
    return uriList.replace("vscode://file", "").split("\n")[0].split("\r")[0];
  }

  return null;
}

function extractFromPlainText(plainText: string): string | null {
  if (!plainText) return null;

  if (plainText.includes("file://")) {
    return plainText.replace("file://", "").split("\n")[0].split("\r")[0];
  } else if (plainText.includes("vscode://")) {
    return plainText.replace("vscode://file", "").split("\n")[0].split("\r")[0];
  }

  return null;
}

function extractPlainPath(plainText: string): string | null {
  if (!plainText) return null;

  const trimmed = plainText.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    return trimmed.split("\n")[0].split("\r")[0];
  }

  return null;
}

function extractFromTextData(textData: string): string | null {
  if (!textData) return null;

  const trimmed = textData.trim();
  if (
    trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.includes("file://")
  ) {
    return trimmed.replace("file://", "").split("\n")[0].split("\r")[0];
  }

  return null;
}

function extractFromHtml(htmlData: string): string | null {
  if (!htmlData) return null;

  // Try to extract file path from HTML content
  const pathMatch = htmlData.match(/data-path="([^"]+)"/);
  if (pathMatch) {
    return pathMatch[1];
  }

  // Also try href
  const hrefMatch = htmlData.match(/href="file:\/\/([^"]+)"/);
  if (hrefMatch) {
    return hrefMatch[1];
  }

  return null;
}

function extractFromFileItems(items: DataTransferItem[]): string | null {
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) {
        // Check if file has a path property (Electron/Tauri specific)
        const fileWithPath = file as unknown as { path?: string };
        if (fileWithPath.path) {
          return fileWithPath.path;
        } else if (file.name.startsWith("/") || /^[A-Za-z]:/.test(file.name)) {
          return file.name;
        }
      }
    }
  }

  return null;
}

function normalizeAndReturn(filePath: string): ExtractedFilePath {
  // Decode URI components and clean up
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Keep original path if decoding fails
  }
  // Remove any trailing whitespace or query params
  filePath = filePath.split("?")[0].trim();
  const fileName = filePath.split("/").pop() || filePath;

  return { filePath, fileName };
}
