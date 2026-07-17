import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CollabOutboxPushItem } from "@src/api/http/project";
import type { CollabOrgRecord } from "@src/store/collaboration/types";

import type { CollabOrgState } from "../sync/CollabSyncBackend";
import { ProjectSyncChannel } from "./ProjectSyncChannel";

const ORG: CollabOrgRecord = {
  id: "org-1",
  name: "Team",
  projectOrgId: "org-1-local",
  createdAt: "2026-06-01T00:00:00.000Z",
};

function orgState(overrides: Partial<CollabOrgState> = {}): CollabOrgState {
  return {
    serverTime: "2026-07-01T12:00:00.000Z",
    projects: [],
    workItems: [],
    ...overrides,
  };
}

function pushItem(
  overrides: Partial<CollabOutboxPushItem> = {}
): CollabOutboxPushItem {
  return {
    entryIds: [1],
    orgId: "org-1-local",
    kind: "work_item",
    entityId: "AAA-0001",
    op: "upsert",
    payload: { id: "AAA-0001", title: "Local title" },
    baseVersion: 3,
    fieldPaths: ["title"],
    ...overrides,
  };
}

function makeDeps() {
  const client = {
    upsertProjectMetadata: vi.fn(async () => ({ id: "p-1", version: 1 })),
    upsertWorkItem: vi.fn(async () => ({ id: "AAA-0001", version: 4 })),
    deleteProjectMetadata: vi.fn(async () => undefined),
    deleteWorkItemMetadata: vi.fn(async () => undefined),
    listOrgState: vi.fn(async () => orgState()),
  };
  const bridge = {
    drainOutbox: vi.fn(async () => [] as CollabOutboxPushItem[]),
    ackOutbox: vi.fn(async () => undefined),
    applyRemote: vi.fn(async () => 0),
    notifyDataChanged: vi.fn(async () => undefined),
    notifyOutboxFlushed: vi.fn(async () => undefined),
  };
  return { client, bridge };
}

describe("ProjectSyncChannel", () => {
  let deps: ReturnType<typeof makeDeps>;
  let channel: ProjectSyncChannel;

  beforeEach(() => {
    deps = makeDeps();
    channel = new ProjectSyncChannel(deps);
  });

  it("keys local access by projectOrgId, falling back to org.id (§16.2)", () => {
    expect(ProjectSyncChannel.projectOrgId(ORG)).toBe("org-1-local");
    expect(
      ProjectSyncChannel.projectOrgId({ ...ORG, projectOrgId: undefined })
    ).toBe("org-1");
  });

  it("drains, pushes with the OCC base version, and acks the server version", async () => {
    deps.bridge.drainOutbox
      .mockResolvedValueOnce([pushItem()])
      .mockResolvedValue([]);

    await channel.sync({ org: ORG, state: orgState() });

    expect(deps.bridge.drainOutbox).toHaveBeenCalledWith({
      orgId: "org-1-local",
      max: 50,
    });
    expect(deps.client.upsertWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        workItem: { id: "AAA-0001", title: "Local title" },
        baseVersion: 3,
      })
    );
    expect(deps.bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({
        entryIds: [1],
        entityId: "AAA-0001",
        ok: true,
        remoteVersion: 4,
      }),
    ]);
    // Push succeeded on round one → no second drain round.
    expect(deps.bridge.drainOutbox).toHaveBeenCalledTimes(1);
    expect(deps.bridge.notifyOutboxFlushed).toHaveBeenCalledTimes(1);
  });

  it("routes delete ops to the delete RPCs", async () => {
    deps.bridge.drainOutbox
      .mockResolvedValueOnce([
        pushItem({
          kind: "project",
          entityId: "p-1",
          op: "delete",
          payload: null,
        }),
      ])
      .mockResolvedValue([]);

    await channel.sync({ org: ORG, state: orgState() });

    expect(deps.client.deleteProjectMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", projectId: "p-1" })
    );
    expect(deps.client.upsertProjectMetadata).not.toHaveBeenCalled();
    expect(deps.bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({ entityId: "p-1", ok: true }),
    ]);
  });

  it("continues after a full successful batch instead of throttling to 50 rows per cycle", async () => {
    const firstBatch = Array.from({ length: 50 }, (_, index) =>
      pushItem({
        entryIds: [index + 1],
        entityId: `AAA-${String(index + 1).padStart(4, "0")}`,
      })
    );
    deps.bridge.drainOutbox
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([
        pushItem({ entryIds: [51], entityId: "AAA-0051" }),
      ]);

    await channel.sync({ org: ORG, state: orgState() });

    expect(deps.bridge.drainOutbox).toHaveBeenCalledTimes(2);
    expect(deps.client.upsertWorkItem).toHaveBeenCalledTimes(51);
    expect(deps.bridge.ackOutbox).toHaveBeenCalledTimes(2);
    expect(deps.bridge.notifyOutboxFlushed).toHaveBeenCalledTimes(1);
  });

  it("on OCC conflict: applies the fresh remote row, acks conflict, retries once with the new base", async () => {
    const staleItem = pushItem({ baseVersion: 3 });
    const rebasedItem = pushItem({ baseVersion: 9, entryIds: [1] });
    deps.bridge.drainOutbox
      .mockResolvedValueOnce([staleItem])
      .mockResolvedValueOnce([rebasedItem])
      .mockResolvedValue([]);
    deps.client.upsertWorkItem
      .mockRejectedValueOnce(new Error("ORGII_CONFLICT"))
      .mockResolvedValueOnce({ id: "AAA-0001", version: 10 });
    const freshRow = {
      id: "AAA-0001",
      title: "Teammate title",
      version: 9,
      updatedByMemberId: "m2",
    };
    deps.client.listOrgState.mockResolvedValue(
      orgState({ workItems: [freshRow] })
    );

    await channel.sync({ org: ORG, state: orgState() });

    // Fresh remote row merged Rust-side before the retry.
    expect(deps.bridge.applyRemote).toHaveBeenCalledWith({
      orgId: "org-1-local",
      orgName: "Team",
      entities: [
        expect.objectContaining({
          kind: "work_item",
          payload: freshRow,
          version: 9,
          updatedBy: "m2",
        }),
      ],
    });
    // Round 1 ack: conflict (immediate requeue Rust-side).
    expect(deps.bridge.ackOutbox).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ ok: false, error: "ORGII_CONFLICT" }),
    ]);
    // Round 2: re-drained snapshot pushed with the fresh base and acked.
    expect(deps.client.upsertWorkItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseVersion: 9 })
    );
    expect(deps.bridge.ackOutbox).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ ok: true, remoteVersion: 10 }),
    ]);
    // Exactly one in-cycle retry: two drains, no third.
    expect(deps.bridge.drainOutbox).toHaveBeenCalledTimes(2);
  });

  it("stops after the retry round even when conflicts persist (no infinite loop)", async () => {
    deps.bridge.drainOutbox.mockResolvedValue([pushItem()]);
    deps.client.upsertWorkItem.mockRejectedValue(new Error("ORGII_CONFLICT"));
    deps.client.listOrgState.mockResolvedValue(orgState());

    await channel.sync({ org: ORG, state: orgState() });

    expect(deps.bridge.drainOutbox).toHaveBeenCalledTimes(2);
    expect(deps.bridge.ackOutbox).toHaveBeenCalledTimes(2);
  });

  it("applies the pulled delta as one batch (projects before work items)", async () => {
    deps.bridge.applyRemote.mockResolvedValue(2);
    const state = orgState({
      projects: [{ id: "p-1", name: "P", version: 2 }],
      workItems: [
        {
          id: "AAA-0001",
          projectId: "p-1",
          version: 5,
          deletedAt: "2026-07-01T00:00:00Z",
        },
      ],
    });

    await channel.sync({ org: ORG, state });

    expect(deps.bridge.applyRemote).toHaveBeenCalledTimes(1);
    expect(deps.bridge.applyRemote).toHaveBeenCalledWith({
      orgId: "org-1-local",
      orgName: "Team",
      entities: [
        expect.objectContaining({ kind: "project", version: 2 }),
        expect.objectContaining({
          kind: "work_item",
          version: 5,
          deletedAt: "2026-07-01T00:00:00Z",
        }),
      ],
    });
    expect(deps.bridge.notifyDataChanged).toHaveBeenCalledTimes(1);
  });

  it("never echoes: an empty delta plus an empty outbox performs no writes", async () => {
    await channel.sync({ org: ORG, state: orgState() });

    expect(deps.bridge.applyRemote).not.toHaveBeenCalled();
    expect(deps.client.upsertWorkItem).not.toHaveBeenCalled();
    expect(deps.client.upsertProjectMetadata).not.toHaveBeenCalled();
    expect(deps.bridge.ackOutbox).not.toHaveBeenCalled();
    expect(deps.bridge.notifyDataChanged).not.toHaveBeenCalled();
    expect(deps.bridge.notifyOutboxFlushed).not.toHaveBeenCalled();
  });

  it("acks non-conflict push failures with the error message (backoff Rust-side)", async () => {
    deps.bridge.drainOutbox
      .mockResolvedValueOnce([pushItem()])
      .mockResolvedValue([]);
    const failure = new Error("ORGII_UNAUTHORIZED");
    deps.client.upsertWorkItem.mockRejectedValueOnce(failure);

    const result = await channel.sync({
      org: ORG,
      state: orgState(),
    });

    expect(deps.bridge.ackOutbox).toHaveBeenCalledWith([
      expect.objectContaining({ ok: false, error: "ORGII_UNAUTHORIZED" }),
    ]);
    // The RAW error also rides the cycle result so an engine can dispatch
    // on plane-level codes (e.g. the cloud ORG2_SYNC_DISABLED backoff)
    // that acks alone would swallow.
    expect(result.pushErrors).toEqual([failure]);
    // Not a conflict → no fresh-row fetch, no retry round.
    expect(deps.client.listOrgState).not.toHaveBeenCalled();
    expect(deps.bridge.drainOutbox).toHaveBeenCalledTimes(1);
    expect(deps.bridge.notifyOutboxFlushed).not.toHaveBeenCalled();
  });

  it("returns no pushErrors on clean cycles and in-channel-handled conflicts", async () => {
    // Clean cycle.
    const clean = await channel.sync({
      org: ORG,
      state: orgState(),
    });
    expect(clean.pushErrors).toEqual([]);

    // Conflicts are the channel's own protocol (apply + requeue + retry) —
    // they must NOT leak into pushErrors.
    deps.bridge.drainOutbox.mockResolvedValue([pushItem()]);
    deps.client.upsertWorkItem.mockRejectedValue(new Error("ORGII_CONFLICT"));
    deps.client.listOrgState.mockResolvedValue(orgState());
    const conflicted = await channel.sync({
      org: ORG,
      state: orgState(),
    });
    expect(conflicted.pushErrors).toEqual([]);
  });
});
