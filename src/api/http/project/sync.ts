/**
 * Pluggable sync framework client.
 *
 * Typed wrappers around the `project_sync_*` Tauri commands. The frontend
 * touches sync state only through this module; consumers never invoke
 * `invoke("project_sync_...")` directly.
 *
 * Wire types are in `./syncTypes.ts`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  AdapterDescriptor,
  ConflictRow,
  ImportProgressInfo,
  OutboxProblemRow,
  SyncMetric,
  SyncStatusEvent,
  SyncStatusReport,
  WebhookInstallInfo,
  WebhookStatusInfo,
} from "./syncTypes";

export type {
  AdapterDescriptor,
  OAuthFlowStart,
  SyncStatusReport,
  SyncStatusEvent,
  EntityType,
  OutboxOp,
  OutboxStatus,
  OutboxProblemRow,
  SyncMetric,
  WebhookInstallInfo,
  WebhookStatusInfo,
  ImportState,
  ImportProgressInfo,
  ConflictFieldDelta,
  ConflictRow,
} from "./syncTypes";
export { CONFLICT_RESOLUTION, OAUTH_FLOW_KIND } from "./syncTypes";

/** Tauri event channel emitted by `project_management::sync::events`. */
const SYNC_STATUS_EVENT = "orgii-project-sync-status";

/**
 * Subscribe to live sync-status updates from the Rust worker.
 * Returns an unlisten cleanup function.
 */
export function subscribeSyncStatus(
  handler: (event: SyncStatusEvent) => void
): () => void {
  const unlistenPromise = listen<SyncStatusEvent>(
    SYNC_STATUS_EVENT,
    (event) => {
      handler(event.payload);
    }
  );
  return () => {
    void unlistenPromise.then((unlisten) => unlisten());
  };
}

export const projectSyncApi = {
  attachAdapter(
    slug: string,
    adapterId: string,
    connectionId: string,
    configJson: string | null = null
  ): Promise<void> {
    return invoke("project_sync_attach_adapter", {
      slug,
      adapterId,
      connectionId,
      configJson,
    });
  },

  detachAdapter(slug: string): Promise<void> {
    return invoke("project_sync_detach_adapter", { slug });
  },

  status(slug: string): Promise<SyncStatusReport> {
    return invoke("project_sync_status", { slug });
  },

  forcePush(slug: string): Promise<number> {
    return invoke("project_sync_force_push", { slug });
  },

  forcePull(slug: string): Promise<void> {
    return invoke("project_sync_force_pull", { slug });
  },

  listAdapters(): Promise<AdapterDescriptor[]> {
    return invoke("project_sync_list_adapters");
  },

  listProblems(slug: string): Promise<OutboxProblemRow[]> {
    return invoke("project_sync_list_problems", { slug });
  },

  retryEntry(entryId: number): Promise<void> {
    return invoke("project_sync_retry_entry", { entryId });
  },

  discardEntry(entryId: number): Promise<void> {
    return invoke("project_sync_discard_entry", { entryId });
  },

  metricsTail(limit: number): Promise<SyncMetric[]> {
    return invoke("project_sync_metrics_tail", { limit });
  },

  webhookInstall(slug: string, adapterId: string): Promise<WebhookInstallInfo> {
    return invoke("project_sync_webhook_install", { slug, adapterId });
  },

  webhookStatus(slug: string, adapterId: string): Promise<WebhookStatusInfo> {
    return invoke("project_sync_webhook_status", { slug, adapterId });
  },

  webhookRotate(slug: string, adapterId: string): Promise<WebhookInstallInfo> {
    return invoke("project_sync_webhook_rotate", { slug, adapterId });
  },

  importStatus(
    slug: string,
    adapterId: string
  ): Promise<ImportProgressInfo | null> {
    return invoke("project_sync_import_status", { slug, adapterId });
  },

  importCancel(slug: string, adapterId: string): Promise<void> {
    return invoke("project_sync_import_cancel", { slug, adapterId });
  },

  importRetry(slug: string, adapterId: string): Promise<void> {
    return invoke("project_sync_import_retry", { slug, adapterId });
  },

  conflictsList(slug: string): Promise<ConflictRow[]> {
    return invoke("project_sync_conflicts_list", { slug });
  },

  conflictsCount(slug: string): Promise<number> {
    return invoke("project_sync_conflicts_count", { slug });
  },

  conflictUseLocal(conflictId: number): Promise<void> {
    return invoke("project_sync_conflict_use_local", { conflictId });
  },

  conflictUseRemote(conflictId: number): Promise<void> {
    return invoke("project_sync_conflict_use_remote", { conflictId });
  },

  conflictDismiss(conflictId: number): Promise<void> {
    return invoke("project_sync_conflict_dismiss", { conflictId });
  },
};

export default projectSyncApi;
