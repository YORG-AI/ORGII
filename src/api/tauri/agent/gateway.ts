/**
 * Agent Gateway API
 *
 * Start/stop/status of the local agent gateway process.
 * Delegates to tauri/rpc for type-safe Zod-validated IPC.
 */
import { rpc } from "@src/api/tauri/rpc";

import type { GatewayStatus } from "./types";

export async function startGateway(): Promise<void> {
  return rpc.gateway.start();
}

export async function stopGateway(): Promise<void> {
  return rpc.gateway.stop();
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  return rpc.gateway.getStatus();
}
