/**
 * RuntimeScanningPanelTypes
 *
 * Shared type definitions for RuntimeScanningPanel: the tab filter and the
 * per-row view model built from a source probe plus its imported-session
 * stats.
 */
import type {
  ExternalCliSourceProbe,
  ExternalSourceStats,
} from "@src/api/tauri/externalHistory";

export type DataSourceTab = "all" | "apps" | "clis";

export interface SourceRow {
  probe: ExternalCliSourceProbe;
  importable: boolean;
  stats: ExternalSourceStats | null;
  statsLoading: boolean;
  rescanning: boolean;
  error: boolean;
}
