import { invoke } from "@tauri-apps/api/core";

import { createLogger } from "@src/hooks/logger";

import type {
  DiagnosticsServiceConfig,
  DiagnosticsUsageSnapshot,
} from "./types";

const logger = createLogger("Diagnostics");

let rustDiagnosticsAvailable: boolean | undefined;

function isMissingDiagnosticsCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("diagnostics_initialize") ||
    message.includes("diagnostics_submit_usage_snapshot") ||
    message.includes("Command") ||
    message.includes("not found") ||
    message.includes("unknown")
  );
}

async function invokeDiagnosticsCommand(
  command: string,
  payload?: Record<string, unknown>
): Promise<boolean> {
  if (rustDiagnosticsAvailable === false) return false;

  try {
    await invoke(command, payload ?? {});
    rustDiagnosticsAvailable = true;
    return true;
  } catch (error) {
    if (isMissingDiagnosticsCommand(error)) {
      rustDiagnosticsAvailable = false;
      logger.debug("Rust Diagnostics command unavailable", command);
      return false;
    }

    throw error;
  }
}

export function resetRustDiagnosticsAvailability(): void {
  rustDiagnosticsAvailable = undefined;
}

export async function diagnosticsInitialize(
  config: DiagnosticsServiceConfig
): Promise<boolean> {
  return invokeDiagnosticsCommand("diagnostics_initialize", { config });
}

export async function diagnosticsSubmitUsageSnapshot(
  snapshot: DiagnosticsUsageSnapshot
): Promise<boolean> {
  return invokeDiagnosticsCommand("diagnostics_submit_usage_snapshot", {
    snapshot,
  });
}
