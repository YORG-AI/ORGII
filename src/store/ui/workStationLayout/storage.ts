const WORK_STATION_PREFIX = "work_station_";

const STORAGE_KEYS = [
  "split_enabled",
  "split_ratio",
  "layout_mode",
  "primary_sidebar_collapsed",
  "primary_sidebar_width",
  "browser_primary_sidebar_collapsed",
  "browser_devtools_position",
  "right_collapsed",
  "devtools_collapsed",
  "bottom_collapsed",
  "bottom_height",
  "title_bar_hidden",
  "status_bar_hidden",
  "follow_agent_highlight",
] as const;

export type WorkStationStorageKey = (typeof STORAGE_KEYS)[number];

function batchReadStorage(): Map<WorkStationStorageKey, string | null> {
  const result = new Map<WorkStationStorageKey, string | null>();

  try {
    for (const key of STORAGE_KEYS) {
      const value = localStorage.getItem(`${WORK_STATION_PREFIX}${key}`);
      result.set(key, value);
    }
  } catch {
    // ignore localStorage errors
  }

  return result;
}

const storedValues = batchReadStorage();

export function getStoredValue(key: WorkStationStorageKey): string | null {
  return storedValues.get(key) ?? null;
}

export function setStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(`${WORK_STATION_PREFIX}${key}`, value);
  } catch {
    // ignore localStorage errors
  }
}
