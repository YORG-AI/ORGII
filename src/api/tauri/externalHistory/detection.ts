import { invoke } from "@tauri-apps/api/core";

export interface ExternalCliCapabilities {
  installedDetection: boolean;
  runningDetection: boolean;
  historyDetection: boolean;
  historyImport: boolean;
}

export interface ExternalCliSourceProbe {
  sourceId: string;
  displayName: string;
  iconId: string;
  detectCommands: string[];
  launchCommand: string;
  expectedProcess: string;
  capabilities: ExternalCliCapabilities;
  installed: boolean;
  executablePath?: string | null;
  running?: boolean | null;
  historyFound: boolean;
  historyPaths: string[];
  status: string;
  importable: boolean;
  /** On-disk store format ORGII parses: "jsonl", "sqlite", or "" (not imported). */
  storeKind: string;
}

export async function externalCliSourcesDetect(): Promise<
  ExternalCliSourceProbe[]
> {
  return invoke<ExternalCliSourceProbe[]>("external_cli_sources_detect");
}

export async function externalCliSourceProbe(
  sourceId: string
): Promise<ExternalCliSourceProbe | null> {
  return invoke<ExternalCliSourceProbe | null>("external_cli_source_probe", {
    sourceId,
  });
}
