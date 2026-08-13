import { invoke } from "@tauri-apps/api/core";

export type AppBuildKind = "local" | "release";
export type AppUpdateInstallStrategy =
  | "inPlace"
  | "separateMacosApplication"
  | "unavailable";

export interface AppBuildProvenance {
  kind: AppBuildKind;
  gitRef: string;
  gitSha: string;
  installStrategy: AppUpdateInstallStrategy;
}

let cachedProvenance: Promise<AppBuildProvenance> | null = null;

export function getAppBuildProvenance(): Promise<AppBuildProvenance> {
  cachedProvenance ??= invoke<AppBuildProvenance>("get_app_build_provenance");
  return cachedProvenance;
}

export function formatAppBuildRevision(provenance: AppBuildProvenance): string {
  const shortSha = provenance.gitSha.slice(0, 8);
  if (provenance.gitRef === "unknown") return shortSha;
  return `${provenance.gitRef}@${shortSha}`;
}

export function resetAppBuildProvenanceForTests(): void {
  cachedProvenance = null;
}
