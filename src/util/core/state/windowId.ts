/**
 * Return a stable ID for the current browser/Tauri window.
 *
 * `sessionStorage` is window-scoped, so repo and workspace persistence can use
 * this ID without sharing state between independently opened app instances.
 * Some WKWebView privacy states throw on storage access; those instances fall
 * back to a stable in-memory ID instead of aborting the synchronous import
 * graph during startup.
 */
let inMemoryWindowId: string | null = null;

function generateWindowId(): string {
  return `window-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function getWindowId(): string {
  if (typeof window === "undefined") {
    return "window-ssr";
  }

  const key = "orgii-window-id";
  try {
    let windowId = sessionStorage.getItem(key);

    if (!windowId) {
      windowId = generateWindowId();
      sessionStorage.setItem(key, windowId);
    }

    return windowId;
  } catch {
    if (!inMemoryWindowId) {
      inMemoryWindowId = generateWindowId();
    }
    return inMemoryWindowId;
  }
}
