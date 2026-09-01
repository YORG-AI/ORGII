/**
 * Central Settings Atom
 *
 * Single source of truth for all user settings.
 * Backed by `~/.orgii/settings.jsonc` via Tauri commands.
 *
 * Flow:
 * - On app startup: reads from file (or creates with defaults)
 * - GUI changes: update atom → write to file
 * - External edits: file watcher → event → update atom
 * - File deleted: reset to defaults → recreate file
 */
import { type Atom, atom } from "jotai";

import { rpcCall } from "@src/api/tauri/rpc/invoke";
import { settings as settingsProcedures } from "@src/api/tauri/rpc/procedures/settings";
import {
  type SettingValue,
  type SettingsKey,
  type SettingsObject,
  generateJsoncContent,
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";
import { generateSettingsJsonSchema } from "@src/config/settingsSchema/generateJsonSchema";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("Settings");

const settingsRpc = {
  read: () => rpcCall(settingsProcedures.read),
  write: (input: { content: string }) =>
    rpcCall(settingsProcedures.write, input),
  writePartial: (input: { partial: Record<string, unknown> }) =>
    rpcCall(settingsProcedures.writePartial, input),
  reset: () => rpcCall(settingsProcedures.reset),
  writeSchema: (input: { schemaContent: string }) =>
    rpcCall(settingsProcedures.writeSchema, input),
};

// ============================================
// Core Atom
// ============================================

/**
 * The central settings atom.
 * Initialized with defaults; hydrated from file during app startup.
 */
export const settingsAtom = atom<SettingsObject>(getSettingsDefaults());
settingsAtom.debugLabel = "settingsAtom";

/**
 * Whether the settings have been loaded from disk.
 * Used to prevent the GUI from showing stale defaults during initial load.
 */
export const settingsLoadedAtom = atom<boolean>(false);
settingsLoadedAtom.debugLabel = "settingsLoadedAtom";

/**
 * The raw settings object as read from disk, including extra keys that are
 * not part of the schema (e.g. `lastModelPair`, `lastModelSelection`).
 * Null until the first settings load completes.
 * Consumers that need non-schema keys (e.g. hydrateCreatorDefaultModelAtom)
 * should read from here instead of issuing a second settings.read() IPC call.
 */
export const rawSettingsAtom = atom<Record<string, unknown> | null>(null);
rawSettingsAtom.debugLabel = "rawSettingsAtom";

let settingsWriteQueue: Promise<void> = Promise.resolve();

/**
 * Keys this window has written but has not yet seen echoed back by the file
 * watcher.
 *
 * Writing a setting is a round trip: the atom updates immediately, the JSONC
 * file is written asynchronously, and the OS watcher then reports the file as
 * changed. That report is indistinguishable from a genuine external edit, so
 * without this overlay a change could be reverted by the echo of an *earlier*
 * write that had not yet included it — which is exactly what made the first
 * change after launch appear to do nothing while a second one stuck. Startup
 * makes this reliably reproducible: `initSettingsAtom` backfills every missing
 * default, so the first user edit almost always races a write already in flight.
 *
 * An entry lives until the watcher confirms it (the file now holds the value we
 * wrote) or until the grace window expires, so a watcher that never fires
 * cannot pin a value forever.
 */
const pendingLocalWrites = new Map<
  string,
  { value: unknown; expiresAt: number }
>();

/**
 * How long a settled write stays authoritative over incoming file state.
 * Only needs to outlast the watcher's own debounce.
 */
const PENDING_WRITE_GRACE_MS = 5_000;

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Local writes that should still win over whatever the file currently says.
 * Expired entries are dropped as a side effect.
 */
function pendingWriteOverlay(): Record<string, unknown> {
  const now = Date.now();
  const overlay: Record<string, unknown> = {};
  for (const [key, entry] of pendingLocalWrites) {
    if (entry.expiresAt <= now) {
      pendingLocalWrites.delete(key);
      continue;
    }
    overlay[key] = entry.value;
  }
  return overlay;
}

/**
 * Retire pending entries the incoming file state already agrees with. Anything
 * still outstanding is a write the file has not caught up to yet.
 */
function confirmPendingWrites(rawSettings: Record<string, unknown>): void {
  for (const [key, entry] of pendingLocalWrites) {
    if (key in rawSettings && sameValue(rawSettings[key], entry.value)) {
      pendingLocalWrites.delete(key);
    }
  }
}

/** Merge file state with any local write the file has not caught up to yet. */
function mergeWithPendingWrites(
  rawSettings: Record<string, unknown>
): Record<string, unknown> {
  confirmPendingWrites(rawSettings);
  const overlay = pendingWriteOverlay();
  return Object.keys(overlay).length > 0
    ? { ...rawSettings, ...overlay }
    : rawSettings;
}

function enqueueSettingsPartialWrite(
  partial: Record<string, unknown>
): Promise<void> {
  // Claimed before the write starts: the atom has already published these
  // values, so an echo arriving mid-flight must not undo them.
  for (const [key, value] of Object.entries(partial)) {
    pendingLocalWrites.set(key, { value, expiresAt: Number.POSITIVE_INFINITY });
  }

  const settle = () => {
    const expiresAt = Date.now() + PENDING_WRITE_GRACE_MS;
    for (const [key, value] of Object.entries(partial)) {
      const entry = pendingLocalWrites.get(key);
      // A newer write for the same key owns the entry now; leave it alone.
      if (!entry || !sameValue(entry.value, value)) continue;
      entry.expiresAt = expiresAt;
    }
  };

  const writePromise = settingsWriteQueue
    .catch(() => undefined)
    .then(() => settingsRpc.writePartial({ partial }));
  settingsWriteQueue = writePromise.then(settle, settle);
  return writePromise;
}

/** Test seam: drop all outstanding local writes. */
export function __resetPendingSettingsWrites(): void {
  pendingLocalWrites.clear();
}

// ============================================
// Read-only atom for a single setting
// ============================================

/**
 * Create a derived read-only atom for a specific setting key.
 * Results are cached so the same key always returns the same atom instance,
 * which is critical for stable Jotai subscriptions (avoids re-mount loops).
 *
 * Usage:
 *   const fontSizeAtom = settingAtom("editor.fontSize");
 *   const fontSize = useAtomValue(fontSizeAtom); // 13
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settingAtomCache = new Map<string, Atom<any>>();

export function settingAtom<K extends SettingsKey>(
  key: K
): Atom<SettingValue<K>> {
  const cached = settingAtomCache.get(key);
  if (cached) return cached as Atom<SettingValue<K>>;

  const derived = atom<SettingValue<K>>((get) => {
    const settings = get(settingsAtom);
    return settings[key];
  });
  derived.debugLabel = `setting:${key}`;
  settingAtomCache.set(key, derived);
  return derived;
}

// ============================================
// Write Operations
// ============================================

/**
 * Atom to update a single setting.
 * Writes to both the in-memory atom and the JSONC file on disk.
 *
 * Usage:
 *   const update = useSetAtom(updateSettingAtom);
 *   update({ key: "editor.fontSize", value: 16 });
 */
export const updateSettingAtom = atom(
  null,
  async (get, set, update: { key: SettingsKey; value: unknown }) => {
    const current = get(settingsAtom);
    const newSettings = { ...current, [update.key]: update.value };
    set(settingsAtom, newSettings);

    try {
      await enqueueSettingsPartialWrite({ [update.key]: update.value });
    } catch (err) {
      log.error("[Settings] Failed to write setting to disk:", err);
    }
  }
);
updateSettingAtom.debugLabel = "updateSettingAtom";

/**
 * Persist a setting before exposing it as saved in memory.
 * Intended for explicit-save forms that must surface disk-write failures.
 */
export const saveSettingAtom = atom(
  null,
  async (_get, set, update: { key: SettingsKey; value: unknown }) => {
    await enqueueSettingsPartialWrite({ [update.key]: update.value });
    set(settingsAtom, (current) => ({
      ...current,
      [update.key]: update.value,
    }));
  }
);
saveSettingAtom.debugLabel = "saveSettingAtom";

/**
 * Persist several settings as one partial-file write before publishing the
 * matching in-memory snapshot. Explicit multi-step flows use this at commit
 * points so progress and outcome cannot diverge.
 */
export const saveSettingsBatchAtom = atom(
  null,
  async (_get, set, updates: Partial<SettingsObject>) => {
    await enqueueSettingsPartialWrite(updates as Record<string, unknown>);
    set(settingsAtom, (current) => ({ ...current, ...updates }));
  }
);
saveSettingsBatchAtom.debugLabel = "saveSettingsBatchAtom";

/**
 * Atom to update multiple settings at once.
 * Useful for batch operations or form submissions.
 */
export const updateSettingsBatchAtom = atom(
  null,
  async (get, set, updates: Partial<SettingsObject>) => {
    const current = get(settingsAtom);
    const newSettings = { ...current, ...updates };
    set(settingsAtom, newSettings);

    try {
      await enqueueSettingsPartialWrite(updates as Record<string, unknown>);
    } catch (err) {
      log.error("[Settings] Failed to write batch settings to disk:", err);
    }
  }
);
updateSettingsBatchAtom.debugLabel = "updateSettingsBatchAtom";

/**
 * Atom to reset all settings to defaults.
 * Deletes the file (watcher will detect it), then recreates with defaults.
 */
export const resetAllSettingsAtom = atom(null, async (_get, set) => {
  const defaults = getSettingsDefaults();
  set(settingsAtom, defaults);

  try {
    await settingsRpc.reset();
    // Recreate with defaults + comments
    const jsonc = generateJsoncContent(defaults);
    await settingsRpc.write({ content: jsonc });
  } catch (err) {
    log.error("[Settings] Failed to reset settings:", err);
  }
});
resetAllSettingsAtom.debugLabel = "resetAllSettingsAtom";

// ============================================
// Initialization (call once on app startup)
// ============================================

/**
 * Load settings from the JSONC file on disk.
 * Merges with defaults to handle new settings added in app updates.
 */
export const initSettingsAtom = atom(null, async (_get, set) => {
  try {
    const rawSettings = await settingsRpc.read();

    // Validate and merge with defaults. A setting changed while this read was
    // in flight must survive it — the read predates the change.
    const validated = validateSettings(mergeWithPendingWrites(rawSettings));
    set(settingsAtom, validated);
    set(rawSettingsAtom, rawSettings);
    set(settingsLoadedAtom, true);

    // Check if the file was empty (first launch) or had fewer schema keys.
    // If so, fill in missing defaults via writePartial (preserves extra keys
    // like lastModelSelection that live alongside schema settings).
    const schemaKeys = Object.keys(validated);
    const missingKeys: Record<string, unknown> = {};
    for (const key of schemaKeys) {
      if (!(key in rawSettings)) {
        missingKeys[key] = (validated as Record<string, unknown>)[key];
      }
    }

    // Both disk writes are non-blocking — the UI is unblocked as soon as
    // `settingsLoadedAtom` is set above. We fire both writes without awaiting
    // so the startup critical path ends here.
    if (Object.keys(missingKeys).length > 0) {
      enqueueSettingsPartialWrite(missingKeys).catch((err) => {
        log.error("[Settings] Failed to backfill missing defaults:", err);
      });
    }

    // Write the JSON Schema alongside the settings file (for editor autocomplete).
    // Deferred to idle time since schema generation involves iterating the full
    // registry and running zod-to-json-schema — no need to block startup.
    const scheduleSchemaWrite = () => {
      try {
        const schema = generateSettingsJsonSchema();
        settingsRpc.writeSchema({ schemaContent: schema }).catch(() => {});
      } catch {
        // Non-critical
      }
    };

    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(scheduleSchemaWrite, { timeout: 5000 });
    } else {
      setTimeout(scheduleSchemaWrite, 2000);
    }
  } catch (err) {
    log.error("[Settings] Failed to load settings from disk:", err);
    // Fall back to defaults (already set in the atom)
    set(settingsLoadedAtom, true);
  }
});
initSettingsAtom.debugLabel = "initSettingsAtom";

/**
 * Handle external file change events from the Tauri watcher.
 * Called when the settings file is modified externally.
 */
export const handleExternalChangeAtom = atom(
  null,
  (_get, set, rawSettings: Record<string, unknown>) => {
    // The watcher cannot distinguish our own write from a genuine external
    // edit, so anything this window wrote and has not seen echoed back yet
    // stays authoritative.
    const validated = validateSettings(mergeWithPendingWrites(rawSettings));
    set(settingsAtom, validated);
  }
);
handleExternalChangeAtom.debugLabel = "handleExternalChangeAtom";

/**
 * Handle settings file deletion.
 * Resets to defaults and recreates the file.
 */
export const handleFileDeletedAtom = atom(null, async (_get, set) => {
  const defaults = getSettingsDefaults();
  set(settingsAtom, defaults);

  // Recreate with defaults
  try {
    const jsonc = generateJsoncContent(defaults);
    await settingsRpc.write({ content: jsonc });
  } catch (err) {
    log.error("[Settings] Failed to recreate settings file:", err);
  }
});
handleFileDeletedAtom.debugLabel = "handleFileDeletedAtom";
