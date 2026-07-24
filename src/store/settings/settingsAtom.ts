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

import {
  SETUP_WALKTHROUGH_OUTCOME_KEY,
  resolveSetupWalkthroughOutcome,
} from "./setupWalkthrough";

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

function enqueueSettingsPartialWrite(
  partial: Record<string, unknown>
): Promise<void> {
  const writePromise = settingsWriteQueue
    .catch(() => undefined)
    .then(() => settingsRpc.writePartial({ partial }));
  settingsWriteQueue = writePromise.then(
    () => undefined,
    () => undefined
  );
  return writePromise;
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

    // Validate and merge with defaults. The first-use setting needs a one-time
    // migration: an empty object means a genuinely new install, while any
    // existing settings file predating the key belongs to an established user.
    const validated = validateSettings(rawSettings);
    const resolvedSetupOutcome = resolveSetupWalkthroughOutcome(rawSettings);
    validated[SETUP_WALKTHROUGH_OUTCOME_KEY] = resolvedSetupOutcome;
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
    // Persist the resolved migration outcome rather than the schema default.
    // Existing profiles therefore stay closed on every subsequent launch.
    if (!(SETUP_WALKTHROUGH_OUTCOME_KEY in rawSettings)) {
      missingKeys[SETUP_WALKTHROUGH_OUTCOME_KEY] = resolvedSetupOutcome;
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
    const validated = validateSettings(rawSettings);
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
