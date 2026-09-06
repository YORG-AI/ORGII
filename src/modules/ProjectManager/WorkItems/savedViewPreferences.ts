import type { SavedViewDisplay } from "@src/api/http/project";

export const SAVED_VIEW_DISPLAY_PREFERENCES_STORAGE_KEY =
  "orgii:work-items:saved-view-display:v1";
export const MAX_SAVED_VIEW_DISPLAY_PREFERENCES = 128;

const SAVED_VIEW_TABS = new Set([
  "List",
  "Table",
  "Kanban",
  "Gantt",
  "Calendar",
]);
const KANBAN_GROUPS = new Set([
  "status",
  "assigned_to",
  "created_by",
  "project",
  "property",
]);

export interface SavedViewPreferenceScope {
  orgId: string;
  projectSlug: string | null;
  ownerId: string;
}

interface StoredDisplayPreference {
  display: SavedViewDisplay;
  updatedAt: number;
}

type DisplayPreferenceRegistry = Record<string, StoredDisplayPreference>;

export type SavedViewPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SavedViewPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function preferenceId(scope: SavedViewPreferenceScope, viewId: string): string {
  return JSON.stringify([
    scope.ownerId.trim() || "local",
    scope.orgId,
    scope.projectSlug,
    viewId,
  ]);
}

function readRegistry(
  storage: SavedViewPreferenceStorage
): DisplayPreferenceRegistry {
  try {
    const raw = storage.getItem(SAVED_VIEW_DISPLAY_PREFERENCES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const registry: DisplayPreferenceRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const candidate = value as Partial<StoredDisplayPreference>;
      if (
        typeof candidate.updatedAt !== "number" ||
        !Number.isFinite(candidate.updatedAt)
      ) {
        continue;
      }
      registry[key] = {
        display: normalizeSavedViewDisplay(candidate.display),
        updatedAt: candidate.updatedAt,
      };
    }
    return registry;
  } catch {
    return {};
  }
}

export function normalizeSavedViewDisplay(
  value: SavedViewDisplay | null | undefined
): SavedViewDisplay {
  if (!value || typeof value !== "object") return {};
  const normalized: SavedViewDisplay = {};
  if (typeof value.viewTab === "string" && SAVED_VIEW_TABS.has(value.viewTab)) {
    normalized.viewTab = value.viewTab;
  }
  if (
    typeof value.kanbanGroupBy === "string" &&
    KANBAN_GROUPS.has(value.kanbanGroupBy)
  ) {
    normalized.kanbanGroupBy = value.kanbanGroupBy;
  }
  if (Array.isArray(value.tableColumns)) {
    normalized.tableColumns = [
      ...new Set(
        value.tableColumns
          .filter((column): column is string => typeof column === "string")
          .map((column) => column.trim())
          .filter(Boolean)
      ),
    ].slice(0, 64);
  }
  if (
    typeof value.propertyGroupBy === "string" &&
    value.propertyGroupBy.trim()
  ) {
    normalized.propertyGroupBy = value.propertyGroupBy.trim().slice(0, 128);
  }
  if (typeof value.sortBy === "string" && value.sortBy.trim()) {
    normalized.sortBy = value.sortBy.trim().slice(0, 128);
  }
  if (value.sortDirection === "asc" || value.sortDirection === "desc") {
    normalized.sortDirection = value.sortDirection;
  }
  // A direction without a column cannot be applied deterministically.
  if (!normalized.sortBy) {
    delete normalized.sortDirection;
  }
  return normalized;
}

export function resolveSavedViewDisplay(
  seedDisplay: SavedViewDisplay | null | undefined,
  personalDisplay: SavedViewDisplay | null
): SavedViewDisplay {
  // A personal preference is a complete snapshot for one saved view. Falling
  // back to the currently rendered layout would leak another view's layout
  // into this view and then persist that leak as a personal override.
  return normalizeSavedViewDisplay(personalDisplay ?? seedDisplay);
}

export function savedViewDisplayFingerprint(display: SavedViewDisplay): string {
  return JSON.stringify(normalizeSavedViewDisplay(display));
}

export function readSavedViewDisplayPreference(
  scope: SavedViewPreferenceScope,
  viewId: string,
  storage: SavedViewPreferenceStorage | null = defaultStorage()
): SavedViewDisplay | null {
  if (!storage) return null;
  const entry = readRegistry(storage)[preferenceId(scope, viewId)];
  return entry ? normalizeSavedViewDisplay(entry.display) : null;
}

export function writeSavedViewDisplayPreference(
  scope: SavedViewPreferenceScope,
  viewId: string,
  display: SavedViewDisplay,
  storage: SavedViewPreferenceStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage) return;
  const registry = readRegistry(storage);
  registry[preferenceId(scope, viewId)] = {
    display: normalizeSavedViewDisplay(display),
    updatedAt: now,
  };
  const bounded = Object.fromEntries(
    Object.entries(registry)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SAVED_VIEW_DISPLAY_PREFERENCES)
  );
  try {
    storage.setItem(
      SAVED_VIEW_DISPLAY_PREFERENCES_STORAGE_KEY,
      JSON.stringify(bounded)
    );
  } catch {
    // Preferences are best-effort; quota/private-mode failures must not block
    // applying the shared view query.
  }
}

export function getActiveSavedViewId(search: string): string | null {
  return new URLSearchParams(search).get("view")?.trim() || null;
}

export function setActiveSavedViewId(
  search: string,
  viewId: string | null
): string {
  const params = new URLSearchParams(search);
  if (viewId) {
    params.set("view", viewId);
  } else {
    params.delete("view");
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}
