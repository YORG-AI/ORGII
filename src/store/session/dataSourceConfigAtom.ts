/**
 * Per-source configuration for external history data sources.
 *
 * Persisted in localStorage (mirrors the `cliAgentVisibilityAtom` pattern).
 * Holds, per importable source id:
 *  - `enabled`  — when false, the source's sessions are NOT loaded anywhere
 *                 (gated in `loadSidebarSessions` and in the Rust aggregation).
 *  - `frequency`— how often the source is auto-scanned; `"default"` inherits the
 *                 global frequency.
 *  - `lastScannedAt` — epoch ms of the last auto/manual scan; machine-written.
 *
 * Auto-scans are cheap, incremental metadata refreshes (the imported_history
 * pipeline delta-syncs by file mtime, so only changed sessions are re-read) —
 * not the destructive full rescan the manual Rescan button performs.
 *
 * Missing entries fall back to {@link DEFAULT_DATA_SOURCE_CONFIG}.
 */
import { atomWithStorage } from "jotai/utils";

/** Concrete auto-scan cadences (usable globally and per-source). */
export type ScanFrequency = "manual" | "60s" | "5m" | "1h" | "1d";

/** Per-source frequency: a concrete cadence, or inherit the global default. */
export type SourceFrequency = ScanFrequency | "default";

/** Refresh cadence for the one external-history session open in Chat. */
export type ActiveExternalSessionRefreshFrequency = "3s" | "5s" | "10s" | "1m";

export interface DataSourceConfig {
  enabled: boolean;
  frequency: SourceFrequency;
  lastScannedAt: number | null;
}

export const DEFAULT_DATA_SOURCE_CONFIG: DataSourceConfig = {
  enabled: true,
  frequency: "default",
  lastScannedAt: null,
};

/** Default global cadence when the user hasn't changed it. */
export const DEFAULT_GLOBAL_FREQUENCY: ScanFrequency = "60s";

export type DataSourceConfigMap = Record<string, DataSourceConfig>;

const CONFIG_STORAGE_KEY = "orgii:dataSourceConfig";
const GLOBAL_FREQ_STORAGE_KEY = "orgii:dataSourceGlobalFrequency";
const ACTIVE_SESSION_REFRESH_STORAGE_KEY =
  "orgii:activeExternalSessionRefreshFrequency";

export const dataSourceConfigAtom = atomWithStorage<DataSourceConfigMap>(
  CONFIG_STORAGE_KEY,
  {}
);

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

export const dataSourceGlobalFrequencyAtom = atomWithStorage<ScanFrequency>(
  GLOBAL_FREQ_STORAGE_KEY,
  DEFAULT_GLOBAL_FREQUENCY
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
  return { ...DEFAULT_DATA_SOURCE_CONFIG, ...(map[sourceId] ?? {}) };
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
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Options offered for the global frequency control. */
export const GLOBAL_FREQUENCIES: readonly ScanFrequency[] = [
  "manual",
  "60s",
  "5m",
  "1h",
  "1d",
];

/** Options offered per source (includes "default" = inherit global). */
export const SOURCE_FREQUENCIES: readonly SourceFrequency[] = [
  "default",
  ...GLOBAL_FREQUENCIES,
];
