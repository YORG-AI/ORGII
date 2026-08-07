/**
 * Tauri-invoke bridge for the ProjectSyncChannel (design §16.8).
 *
 * Kept in its own module so engine tests can mock the whole bridge in
 * one place — the channel itself is pure orchestration over this
 * interface plus the supabase client.
 */
import { emit } from "@tauri-apps/api/event";

import { projectApi } from "@src/api/http/project";
import type {
  CollabOutboxAckResult,
  CollabOutboxPushItem,
  CollabRemoteEntity,
} from "@src/api/http/project";

export interface ProjectSyncBridge {
  drainOutbox(input: {
    orgId: string;
    max?: number;
  }): Promise<CollabOutboxPushItem[]>;
  ackOutbox(results: CollabOutboxAckResult[]): Promise<void>;
  applyRemote(input: {
    orgId: string;
    orgName?: string;
    entities: CollabRemoteEntity[];
  }): Promise<number>;
  /** UI refresh signal after remote rows landed locally. */
  notifyDataChanged(): Promise<void>;
  notifyOutboxFlushed(): Promise<void>;
}

export const COLLAB_OUTBOX_FLUSHED_EVENT = "orgii-collab-outbox-flushed";

export const tauriProjectSyncBridge: ProjectSyncBridge = {
  drainOutbox: (input) => projectApi.drainCollabOutbox(input),
  ackOutbox: (results) => projectApi.ackCollabOutbox(results),
  applyRemote: (input) => projectApi.applyCollabRemote(input),
  async notifyDataChanged() {
    // Same signal every local mutation site emits; useProjectDataChanged
    // consumers (project lists, work item views) refetch on it.
    await emit("orgii-data-changed");
  },
  async notifyOutboxFlushed() {
    window.dispatchEvent(new CustomEvent(COLLAB_OUTBOX_FLUSHED_EVENT));
  },
};
