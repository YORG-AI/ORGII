// ============================================
// Utility Functions
// ============================================

/**
 * Format timestamp to HH:MM:SS format
 */
export function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return "—";
  }
}

/**
 * Format duration in milliseconds to seconds string
 */
export function formatDuration(duration?: number): string {
  if (!duration) return "—";
  // Always show in seconds (e.g., 0.05s, 0.1s, 1.23s)
  return `${(duration / 1000).toFixed(2)}s`;
}

/**
 * Get human-readable label for trigger type
 */
export function getTriggerLabel(type?: string): string {
  switch (type) {
    case "click":
      return "Click";
    case "hover":
      return "Hover";
    case "keyboard":
      return "Keyboard";
    case "focus":
      return "Focus";
    case "auto":
      return "Auto";
    default:
      return "Auto";
  }
}

/**
 * Get status information for API call
 */
export function getStatusInfo(
  status?: number,
  error?: unknown,
  duration?: number
): { class: string; label: string } {
  const durationText = duration ? ` • ${formatDuration(duration)}` : "";

  if (error) return { class: "status-error", label: `Error${durationText}` };
  if (!status) return { class: "status-pending", label: "Pending" };
  if (status >= 200 && status < 300)
    return { class: "status-success", label: `${status}${durationText}` };
  if (status >= 400)
    return { class: "status-error", label: `${status}${durationText}` };
  return { class: "status-success", label: `${status}${durationText}` };
}

/**
 * Format JSON object to string with max length limit
 */
export function formatJson(obj: unknown, maxLength: number = 300): string {
  if (!obj) return "—";
  try {
    const str = JSON.stringify(obj, null, 2);
    if (str.length > maxLength) {
      return str.slice(0, maxLength) + "...";
    }
    return str;
  } catch {
    return String(obj);
  }
}

/**
 * Format API URL by removing localhost prefix
 */
export function formatApiUrl(fullUrl: string): string {
  try {
    // Remove https://127.0.0.1: prefix
    // Match pattern: https://127.0.0.1:PORT/path or http://127.0.0.1:PORT/path
    const localHostPattern = /^https?:\/\/127\.0\.0\.1:(\d+)(\/.*)?$/;
    const match = fullUrl.match(localHostPattern);

    if (match) {
      const port = match[1];
      const path = match[2] || "/";
      return `${port}${path}`;
    }

    // If it doesn't match the pattern, return the original URL
    return fullUrl;
  } catch {
    return fullUrl;
  }
}
