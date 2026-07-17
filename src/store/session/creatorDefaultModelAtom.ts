/**
 * Creator Default Model Atom
 *
 * Persists the **session creator's default** model+source pair per dispatch
 * category (cli / rust_agent).
 *
 * Primary use: pre-fill the SessionCreator when a user starts a brand-new
 * session. Once a session exists, its model lives on the session record
 * (`Session.model` / `cliAgentType` / `keySource` / `accountId`) and is the
 * single source of truth.
 *
 * Allowed fallback: dispatcher hooks (`useQueueDispatch`, `useMessageDispatch`,
 * `useModeSwitchActions`) may read this atom ONLY as a last-resort fallback via
 * `selectionFromSession(session, creatorDefaultSelection)` — which only uses it
 * when the session row itself has no model set (i.e. the very first message of a
 * newly-created session before any model pill interaction). Do NOT read from
 * ChatPanel UI components (pills, status bars, etc.).
 *
 * Storage type is `RecentModelEntry` — the same validated pair shape used by
 * the "Recent Models" tab. This guarantees the stored model and source were
 * selected together, preventing franken-combinations like "Kimi model + OpenAI
 * source" that the old flat-bag `LastModelSelection` allowed.
 *
 * Two-tier storage:
 *   - **localStorage** (`orgii:lastModelPair`) — synchronous write-through
 *     cache. Seeded into the module-level `cachedMap` on load so that the
 *     creator default returns data immediately, even before the async Rust
 *     backend is available. (Storage key is kept as `lastModelPair` for
 *     backwards-compat with existing user installs.)
 *   - **settings.jsonc** (`lastModelPair` key) — authoritative source,
 *     shared across Tauri windows. Loaded via async RPC during hydration.
 *
 * Read path: `creatorDefaultModelSelectionAtom` derives a `LastModelSelection`
 * from the stored `RecentModelEntry`.
 *
 * Write path: accepts `RecentModelEntry | null` only — no partial-merge
 * updater function. Every write replaces the pair atomically.
 */
import { atom } from "jotai";

import { rpc } from "@src/api/tauri/rpc";
import type {
  CliAgentType,
  ModelType,
} from "@src/api/tauri/rpc/schemas/validation";
import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import { formatAgentType } from "@src/assets/providers";
import type {
  AdvancedConfig,
  KeySource,
} from "@src/features/SessionCreator/types";
import { createLogger } from "@src/hooks/logger";
import {
  rawSettingsAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";
import { formatModelNameFull } from "@src/util/formatModelName";

import { dispatchCategoryAtom } from "./creatorStateAtom";
import type { RecentModelEntry } from "./recentModelEntriesAtom";

const log = createLogger("CreatorDefaultModel");

// ============================================
// Type Definitions
// ============================================

/** Read-only derived type consumed by dispatch, UI, and queue code. */
export interface LastModelSelection {
  keySource?: KeySource;
  provider?: string;
  model?: string;
  selectedAccountId?: string;
  cliAgentType?: CliAgentType;
  cliAgentLabel?: string;
  cliModelDisplay?: string;
  tier?: string;
  listingModel?: string;
  listingModelDisplay?: string;
  listingModelType?: ModelType;
  listingName?: string;
  selectedSourceLabel?: string;
  selectedSourceModelType?: ModelType;
}

type LastModelPairMap = Partial<Record<string, RecentModelEntry>>;

// ============================================
// Settings key + persistence
// ============================================

const SETTINGS_KEY = "lastModelPair";
const LOCAL_STORAGE_KEY = "orgii:lastModelPair";

function loadLocalStorageCache(): LastModelPairMap {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as LastModelPairMap;
      }
    }
  } catch {
    // Corrupt or unavailable — start empty
  }
  return {};
}

let cachedMap: LastModelPairMap = loadLocalStorageCache();

function writeLocalStorageCache(map: LastModelPairMap): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be full or unavailable
  }
}

function persistToSettings(map: LastModelPairMap): void {
  writeLocalStorageCache(map);
  rpc.settings
    .writePartial({ partial: { [SETTINGS_KEY]: map } })
    .catch((err: unknown) => {
      log.error("[LastModelPair] Failed to persist:", err);
    });
}

// ============================================
// Internal Map Atom (per-category, in-memory)
// ============================================

const creatorDefaultModelMapAtom = atom<LastModelPairMap>(cachedMap);

/**
 * Raw creator-default pair for the current dispatch category.
 *
 * Read-only. Prefer this over `creatorDefaultModelSelectionAtom` when you need
 * the underlying `RecentModelEntry` (e.g. to run compatibility validation
 * inside the creator). Callers writing the default should still go through
 * `creatorDefaultModelSelectionAtom`.
 *
 * **Creator-only.** Do not read from in-session UI.
 */
export const lastModelPairMapAtom = atom(
  (get): LastModelPairMap => get(creatorDefaultModelMapAtom)
);

export const creatorDefaultModelPairAtom = atom(
  (get): RecentModelEntry | null => {
    const map = get(creatorDefaultModelMapAtom);
    const category = get(dispatchCategoryAtom);
    return map[category] ?? null;
  }
);

// ============================================
// Derive LastModelSelection from RecentModelEntry
// ============================================

export function deriveLastModelSelection(
  pair: RecentModelEntry
): LastModelSelection {
  if (isHostedKey(pair.sourceType)) {
    return {
      keySource: KEY_SOURCE.HOSTED,
      listingModel: pair.modelId,
      listingModelDisplay: formatModelNameFull(pair.modelId),
      listingModelType: pair.modelType,
      cliAgentType: pair.cliAgentType,
      cliAgentLabel: pair.cliAgentLabel,
      cliModelDisplay: pair.cliModelDisplay,
      selectedSourceLabel: pair.accountName ?? "Token Market",
      selectedSourceModelType: pair.modelType,
    };
  }
  return {
    keySource: KEY_SOURCE.OWN,
    model: pair.modelId,
    provider: pair.modelType as string,
    selectedAccountId: pair.accountId,
    cliAgentType: pair.cliAgentType,
    cliAgentLabel: pair.cliAgentLabel,
    cliModelDisplay: pair.cliModelDisplay,
    selectedSourceLabel: pair.accountName,
    selectedSourceModelType: pair.modelType,
  };
}

// ============================================
// Hydration (call once at app startup)
// ============================================

async function pruneStaleEntries(map: LastModelPairMap): Promise<{
  pruned: LastModelPairMap;
  changed: boolean;
}> {
  try {
    const keys = await rpc.validation.listKeys();
    const validIds = new Set(keys.map((key) => key.id));

    let changed = false;
    const result: LastModelPairMap = { ...map };
    for (const [category, entry] of Object.entries(result)) {
      if (!entry) continue;

      if (isHostedKey(entry.sourceType)) continue;

      if (!entry.accountId || !validIds.has(entry.accountId)) {
        result[category] = undefined;
        changed = true;
      }
    }
    return { pruned: result, changed };
  } catch (err) {
    log.error("[lastModelAtom] Failed to prune stale entries:", err);
    return { pruned: map, changed: false };
  }
}

export const hydrateCreatorDefaultModelAtom = atom(null, async (get, set) => {
  try {
    // Use the cached raw settings (which includes non-schema keys like
    // lastModelPair) if settings have already been loaded. Falls back to a
    // direct RPC read only on the very first cold start before initSettingsAtom
    // has run — in practice AppBootstrap gates this effect on settingsLoadedAtom,
    // so the fallback path is a safety net only.
    const settingsLoaded = get(settingsLoadedAtom);
    const rawSettings: Record<string, unknown> =
      settingsLoaded && get(rawSettingsAtom) !== null
        ? (get(rawSettingsAtom) as Record<string, unknown>)
        : await rpc.settings.read();

    let loaded: LastModelPairMap = {};
    const stored = rawSettings[SETTINGS_KEY];

    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      loaded = stored as LastModelPairMap;
    }

    const { pruned, changed } = await pruneStaleEntries(loaded);

    cachedMap = pruned;
    set(creatorDefaultModelMapAtom, cachedMap);
    writeLocalStorageCache(cachedMap);

    if (changed || !stored) {
      persistToSettings(cachedMap);
    }
  } catch (err) {
    log.error("[CreatorDefaultModel] Hydration failed:", err);
  }
});

// ============================================
// Public Read Atom: LastModelSelection (derived)
// ============================================

/**
 * **Creator-only.** Pre-fills the SessionCreator with the user's last
 * model+source choice for the active dispatch category.
 *
 * - Read: derives `LastModelSelection` from the stored `RecentModelEntry`.
 * - Write: accepts `RecentModelEntry | null` — always replaces atomically.
 *
 * Dispatcher hooks (`useQueueDispatch`, `useMessageDispatch`,
 * `useModeSwitchActions`) may use this as a fallback via
 * `selectionFromSession(session, creatorDefaultSelection)` — it is only
 * consumed when the session row has no model. In-session UI components
 * (ChatPanel `ModelPill`/`ModePill`) must read `sessionByIdAtom(sessionId)`
 * directly and must NOT fall back to this atom.
 */
export const creatorDefaultModelSelectionAtom = atom(
  (get): LastModelSelection | null => {
    const pair = get(creatorDefaultModelPairAtom);
    return pair ? deriveLastModelSelection(pair) : null;
  },
  (get, set, entry: RecentModelEntry | null) => {
    const map = get(creatorDefaultModelMapAtom);
    const category = get(dispatchCategoryAtom);

    const newMap: LastModelPairMap = {
      ...map,
      [category]: entry ?? undefined,
    };

    cachedMap = newMap;
    set(creatorDefaultModelMapAtom, newMap);
    persistToSettings(newMap);
  }
);

// ============================================
// Stale account cleanup
// ============================================

export const clearStaleAccountIdAtom = atom(
  null,
  (get, set, deletedAccountId: string) => {
    const map = get(creatorDefaultModelMapAtom);
    let changed = false;
    const newMap: LastModelPairMap = { ...map };

    for (const [category, entry] of Object.entries(newMap)) {
      if (entry?.accountId === deletedAccountId) {
        newMap[category] = undefined;
        changed = true;
      }
    }

    if (changed) {
      cachedMap = newMap;
      set(creatorDefaultModelMapAtom, newMap);
      persistToSettings(newMap);
    }
  }
);

// ============================================
// AdvancedConfig → RecentModelEntry Helper
// ============================================

/**
 * Extract a validated model+source pair from AdvancedConfig.
 * Returns null if no meaningful selection exists.
 */
export function extractModelPair(
  config: AdvancedConfig
): RecentModelEntry | null {
  const keySource = config.keySource ?? KEY_SOURCE.OWN;

  if (isHostedKey(keySource)) {
    if (!config.listingModel) return null;
    return {
      modelId: config.listingModel,
      sourceType: KEY_SOURCE.HOSTED,
      accountName: config.selectedSourceLabel ?? "Token Market",
      modelType:
        config.listingModelType ??
        config.selectedSourceModelType ??
        ("orgii_orchestrator" as ModelType),
      cliAgentType: config.cliAgentType,
      cliAgentLabel: config.cliAgentType
        ? formatAgentType(config.cliAgentType)
        : undefined,
      cliModelDisplay: config.listingModelDisplay ?? config.listingModel,
    };
  }

  if (!config.selectedAccountId) return null;
  if (!config.model) return null;

  return {
    modelId: config.model,
    sourceType: KEY_SOURCE.OWN,
    accountId: config.selectedAccountId,
    accountName: config.selectedSourceLabel,
    modelType:
      config.selectedSourceModelType ??
      (config.provider as ModelType) ??
      ("unknown" as ModelType),
    cliAgentType: config.cliAgentType,
    cliAgentLabel: config.cliAgentType
      ? formatAgentType(config.cliAgentType)
      : undefined,
    cliModelDisplay: formatModelNameFull(config.model),
  };
}
