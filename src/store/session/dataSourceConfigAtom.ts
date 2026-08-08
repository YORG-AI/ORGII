/**
 * Per-source configuration for external history data sources.
 *
 * Persisted in localStorage (mirrors the `cliAgentVisibilityAtom` pattern).
 * Holds, per importable source id:
 *  - `enabled`  — when false, the source's sessions are NOT loaded anywhere
 *                 (gated in `loadSidebarSessions` and in the Rust aggregation).
 *  - `frequency`— how often the source is auto-scanned; `"default"` inherits the
 *                 global frequency.
 *  - `lastScannedAt` — epoch ms of the last completed importer run or confirmed
 *                      absence check; machine-written for the Runtime UI.
 *
 * Auto-scans are cheap, incremental metadata refreshes (the imported_history
 * pipeline delta-syncs by file mtime, so only changed sessions are re-read) —
 * not the destructive full rescan the manual Rescan button performs.
 *
 * Missing entries fall back to {@link DEFAULT_DATA_SOURCE_CONFIG}.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** Concrete auto-scan cadences (usable globally and per-source). */
export type ScanFrequency = "manual" | "60s" | "120s" | "10m" | "30m" | "1h";

/** Per-source frequency: a concrete cadence, or inherit the global default. */
export type SourceFrequency = ScanFrequency | "default";

/** Refresh cadence for the one external-history session open in Chat. */
export type ActiveExternalSessionRefreshFrequency = "3s" | "5s" | "10s" | "1m";

export interface DataSourceConfig {
  enabled: boolean;
  frequency: SourceFrequency;
  lastScannedAt: number | null;
}

/**
 * Machine-owned result of the lightweight on-disk history-store probe.
 * Kept separate from {@link DataSourceConfig}: the latter is user policy,
 * while this state only controls whether the scheduler runs a full importer.
 */
export interface DataSourcePresence {
  historyFound: boolean;
  checkedAt: number;
}

export const DEFAULT_DATA_SOURCE_CONFIG: DataSourceConfig = {
  enabled: true,
  frequency: "default",
  lastScannedAt: null,
};

/**
 * Default global cadence when the user hasn't changed it.
 *
 * The open external session has its own cheap 5-second transcript-signature
 * probe, so rescanning every provider once a minute does not improve the chat
 * someone is watching. On a populated machine that global pass also reloads
 * the sidebar and rechecks children for changed parent sessions, producing a
 * visible CPU/allocation spike. Ten minutes keeps discovery reasonably fresh
 * while leaving the explicit 60-second option available to users who need it.
 */
export const DEFAULT_GLOBAL_FREQUENCY: ScanFrequency = "10m";

export type DataSourceConfigMap = Record<string, DataSourceConfig>;

const CONFIG_STORAGE_KEY = "orgii:dataSourceConfig";
const PRESENCE_STORAGE_KEY = "orgii:dataSourcePresence";
const GLOBAL_FREQ_STORAGE_KEY = "orgii:dataSourceGlobalFrequency";
const ACTIVE_SESSION_REFRESH_STORAGE_KEY =
  "orgii:activeExternalSessionRefreshFrequency";

const LEGACY_FREQUENCY_MIGRATIONS: Readonly<Record<string, ScanFrequency>> = {
  "5m": "10m",
  "1d": "1h",
};

function parseScanFrequency(value: unknown): ScanFrequency | null {
  switch (value) {
    case "manual":
    case "60s":
    case "120s":
    case "10m":
    case "30m":
    case "1h":
      return value;
    default:
      return typeof value === "string"
        ? (LEGACY_FREQUENCY_MIGRATIONS[value] ?? null)
        : null;
  }
}

/** Normalize persisted global values from earlier cadence menus. */
export function normalizeScanFrequency(value: unknown): ScanFrequency {
  return parseScanFrequency(value) ?? DEFAULT_GLOBAL_FREQUENCY;
}

/** Normalize persisted per-source values while preserving global inheritance. */
export function normalizeSourceFrequency(value: unknown): SourceFrequency {
  if (value === "default") return "default";
  return parseScanFrequency(value) ?? "default";
}

export const dataSourceConfigAtom = atomWithStorage<DataSourceConfigMap>(
  CONFIG_STORAGE_KEY,
  {}
);

export const dataSourcePresenceAtom = atomWithStorage<
  Record<string, DataSourcePresence>
>(PRESENCE_STORAGE_KEY, {});

/**
 * Per-source backend cache signature captured at the last rescan-driven
 * roster reload. The auto-scan compares fresh rescan signatures against this
 * baseline: a drift means SOME caller's sync (kanban, usage, transcript
 * pagers — not necessarily the rescan itself) changed cached rows since the
 * sidebar last read them, e.g. a continuation demotion, so a reload is due
 * even when the rescan reports no changes of its own. Deliberately in-memory
 * only: losing it merely costs one reload after relaunch, while persisting it
 * could suppress the startup reload that heals a stale persisted sidebar.
 */
export const dataSourceRosterSignaturesAtom = atom<Record<string, string>>({});

/**
 * Runtime-only demand signal for keeping enabled external-history providers
 * fresh while the document is hidden. Cloud collaboration raises this while
 * at least one accessible org has Background upload enabled; the scanner owns
 * the cadence and still honors the master switch, per-source enablement, and
 * explicit manual frequency.
 *
 * This is deliberately not persisted: cloud policy is authoritative and is
 * re-established after the signed-in roster loads. Keeping the atom in the
 * data-source layer avoids a reverse dependency from the scanner into Cloud.
 */
export const externalHistoryBackgroundScanEnabledAtom = atom(false);

const EXTERNAL_SESSIONS_ENABLED_STORAGE_KEY = "orgii:externalSessionsEnabled";

/**
 * Master switch for external-session integration (default on). When off, no
 * external source is scanned or loaded anywhere: the auto-scan scheduler,
 * manual rescans, sidebar/list loading and the open-replay auto-refresh all
 * skip external history. Per-source `enabled` flags are preserved and take
 * effect again when this is switched back on.
 */
export const externalSessionsEnabledAtom = atomWithStorage<boolean>(
  EXTERNAL_SESSIONS_ENABLED_STORAGE_KEY,
  true
);

const persistedDataSourceGlobalFrequencyAtom = atomWithStorage<unknown>(
  GLOBAL_FREQ_STORAGE_KEY,
  DEFAULT_GLOBAL_FREQUENCY
);

export const dataSourceGlobalFrequencyAtom = atom(
  (get) => normalizeScanFrequency(get(persistedDataSourceGlobalFrequencyAtom)),
  (_get, set, frequency: ScanFrequency) => {
    set(persistedDataSourceGlobalFrequencyAtom, frequency);
  }
);

export const DEFAULT_ACTIVE_EXTERNAL_SESSION_REFRESH_FREQUENCY: ActiveExternalSessionRefreshFrequency =
  "5s";

export const activeExternalSessionRefreshFrequencyAtom =
  atomWithStorage<ActiveExternalSessionRefreshFrequency>(
    ACTIVE_SESSION_REFRESH_STORAGE_KEY,
    DEFAULT_ACTIVE_EXTERNAL_SESSION_REFRESH_FREQUENCY
  );

export const ACTIVE_EXTERNAL_SESSION_REFRESH_FREQUENCIES: readonly ActiveExternalSessionRefreshFrequency[] =
  ["3s", "5s", "10s", "1m"];

export const ACTIVE_EXTERNAL_SESSION_REFRESH_INTERVAL_MS: Record<
  ActiveExternalSessionRefreshFrequency,
  number
> = {
  "3s": 3_000,
  "5s": 5_000,
  "10s": 10_000,
  "1m": 60_000,
};

/** Resolve a source's config, applying defaults for any missing fields. */
export function getSourceConfig(
  map: DataSourceConfigMap,
  sourceId: string
): DataSourceConfig {
  const config = { ...DEFAULT_DATA_SOURCE_CONFIG, ...(map[sourceId] ?? {}) };
  return {
    ...config,
    frequency: normalizeSourceFrequency(config.frequency),
  };
}

/** True only when the source has been explicitly disabled. */
export function isSourceDisabled(
  map: DataSourceConfigMap,
  sourceId: string
): boolean {
  return map[sourceId]?.enabled === false;
}

/** The source's effective cadence, resolving `"default"` to the global one. */
export function effectiveFrequency(
  config: DataSourceConfig,
  globalFrequency: ScanFrequency
): ScanFrequency {
  return config.frequency === "default" ? globalFrequency : config.frequency;
}

/** Auto-scan interval per cadence, in ms. `null` = manual (never auto). */
export const FREQUENCY_INTERVAL_MS: Record<ScanFrequency, number | null> = {
  manual: null,
  "60s": 60_000,
  "120s": 120_000,
  "10m": 10 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

/** Options offered for the global frequency control. */
export const GLOBAL_FREQUENCIES: readonly ScanFrequency[] = [
  "manual",
  "60s",
  "120s",
  "10m",
  "30m",
  "1h",
];

/** Options offered per source (includes "default" = inherit global). */
export const SOURCE_FREQUENCIES: readonly SourceFrequency[] = [
  "default",
  ...GLOBAL_FREQUENCIES,
];
