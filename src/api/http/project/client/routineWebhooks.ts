/**
 * Routine webhook install / rotate / status / delivery replay commands.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  RoutineWebhookDelivery,
  RoutineWebhookInstallInfo,
  RoutineWebhookStatus,
} from "../types";

export async function installRoutineWebhook(
  routineName: string
): Promise<RoutineWebhookInstallInfo> {
  return invoke("project_routine_webhook_install", { routineName });
}

export async function rotateRoutineWebhook(
  routineName: string
): Promise<RoutineWebhookInstallInfo> {
  return invoke("project_routine_webhook_rotate", { routineName });
}

export async function routineWebhookStatus(
  routineName: string
): Promise<RoutineWebhookStatus> {
  return invoke("project_routine_webhook_status", { routineName });
}

export async function setRoutineWebhookEnabled(
  routineName: string,
  enabled: boolean
): Promise<RoutineWebhookStatus> {
  return invoke("project_routine_webhook_set_enabled", {
    routineName,
    enabled,
  });
}

export async function listRoutineWebhookDeliveries(
  routineName: string,
  limit = 50
): Promise<RoutineWebhookDelivery[]> {
  return invoke("project_routine_webhook_list_deliveries", {
    routineName,
    limit,
  });
}

export async function replayRoutineWebhookDelivery(
  deliveryId: string
): Promise<RoutineWebhookDelivery> {
  return invoke("project_routine_webhook_replay", { deliveryId });
}
