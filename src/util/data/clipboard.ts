/**
 * Copy text to clipboard.
 *
 * Tries `navigator.clipboard` first (works when triggered by a user gesture).
 * Falls back to a Tauri `clipboard_write_text` command so copies still work
 * after an async RPC call where the browser gesture token has expired.
 */
const BROWSER_CLIPBOARD_TIMEOUT_MS = 1_000;

async function writeBrowserClipboard(text: string): Promise<void> {
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!write) throw new Error("Browser clipboard API unavailable");
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      write(text),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Browser clipboard write timed out")),
          BROWSER_CLIPBOARD_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    // Some WKWebView versions leave a denied write pending forever instead
    // of rejecting it. Bound this tier so the native fallback stays usable.
    await writeBrowserClipboard(text);
    return;
  } catch {
    // Gesture expired or API unavailable — fall through to Tauri
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("clipboard_write_text", { text });
    return;
  } catch {
    // Tauri not available — fall through to textarea fallback
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("Clipboard write failed");
  }
}
