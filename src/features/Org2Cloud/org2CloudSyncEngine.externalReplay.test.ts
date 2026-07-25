import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCOPE_KEY,
  SESSION,
  cleanupEngineFixture,
  conflictError,
  createEngineFixture,
  engineTestDeps,
  eventStoreMock,
  externalReplayCloudPrefixHashMock,
  externalReplayCloudPrepareMock,
  externalReplayCloudReadBatchMock,
  externalReplayCloudReleaseMock,
  makeEvent,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS,
  cloudOrgToken,
  org2CloudAccessSettingsAtom,
  org2CloudOrgsAtom,
  org2CloudPushCursorsAtom,
  org2CloudRepoScopesAtom,
  org2CloudSharingFloorAtom,
  sessionOrgTagsAtom,
  sessionsAtom,
} = engineTestDeps;

describe("Org2CloudSyncEngine bounded external replay publishing", () => {
  let fixture: EngineFixture;
  let store: EngineFixture["store"];
  let client: EngineFixture["client"];
  let engine: EngineFixture["engine"];

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ store, client, engine } = fixture);
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
  });

  it("uploads one bounded external spool only to the active org", async () => {
    const events = [makeEvent("x1"), makeEvent("x2"), makeEvent("x3")];
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "shared-external-spool",
      generation: "g1",
      totalCount: 3,
      frozenEventCount: 3,
      tailEventCount: 0,
      frozenChainHash: "chain-3",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments:
          startEventIndex < endEventIndex
            ? [
                {
                  payloadGz: `wire-${events[startEventIndex]?.id}`,
                  eventCount: 1,
                  segmentHash: `hash-${events[startEventIndex]?.id}`,
                  wireBytes: 100,
                },
              ]
            : [],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": { sessionModes: {}, sessionVisibility: {} },
      "corg-2": { sessionModes: {}, sessionVisibility: {} },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-1": "full_replay",
      "corg-2": "full_replay",
    });
    store.set(sessionOrgTagsAtom, {
      "cursoride-thread-1": [cloudOrgToken("corg-1"), cloudOrgToken("corg-2")],
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(3);
    expect(client.uploadSessionEventWires).toHaveBeenCalledTimes(3);
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalledWith(
      "cursoride-thread-1"
    );
    expect(client.rewriteSessionEventWires.mock.calls[0]?.[1].orgId).toBe(
      "corg-1"
    );
    expect(
      client.uploadSessionEventWires.mock.calls.every(
        ([, input]) => input.orgId === "corg-1"
      )
    ).toBe(true);
    expect(
      client.rewriteSessionEventWires.mock.calls[0]?.[1].frozenSegments
    ).toHaveLength(3);
  });

  it("keeps nine active-org external session spools independently bounded", async () => {
    const sessionIds = Array.from(
      { length: 9 },
      (_, index) => `cursoride-thread-${index + 1}`
    );
    externalReplayCloudPrepareMock.mockImplementation(async (sessionId) => ({
      token: `nine-spool-${sessionId}`,
      generation: `generation-${sessionId}`,
      totalCount: 1,
      frozenEventCount: 1,
      tailEventCount: 0,
      frozenChainHash: `chain-${sessionId}`,
      tailHash: null,
    }));
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ token, startEventIndex, endEventIndex }) => ({
        segments: [
          {
            payloadGz: `wire-${token}`,
            eventCount: 1,
            segmentHash: `hash-${token}`,
            wireBytes: 100,
          },
        ],
        startEventIndex,
        nextEventIndex: endEventIndex,
        startSegmentIndex: 0,
        nextSegmentIndex: 1,
        eof: true,
        serializedBytes: 100,
      })
    );
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, {
      "corg-1": [SCOPE_KEY],
      "corg-2": [SCOPE_KEY],
    });
    store.set(org2CloudAccessSettingsAtom, {
      "corg-1": { sessionModes: {}, sessionVisibility: {} },
      "corg-2": { sessionModes: {}, sessionVisibility: {} },
    });
    store.set(org2CloudSharingFloorAtom, {
      "corg-1": "full_replay",
      "corg-2": "full_replay",
    });
    store.set(
      sessionOrgTagsAtom,
      Object.fromEntries(
        sessionIds.map((sessionId) => [
          sessionId,
          [cloudOrgToken("corg-1"), cloudOrgToken("corg-2")],
        ])
      )
    );
    store.set(
      sessionsAtom,
      sessionIds.map((sessionId) => ({
        ...SESSION,
        session_id: sessionId,
        orgId: "personal-org",
      }))
    );

    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrepareMock).toHaveBeenCalledTimes(9);
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(9);
    expect(client.uploadSessionEventWires).toHaveBeenCalledTimes(9);
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(9);
    expect(
      client.rewriteSessionEventWires.mock.calls.every(
        ([, input]) => input.orgId === "corg-1"
      )
    ).toBe(true);
    for (const sessionId of sessionIds) {
      const token = `nine-spool-${sessionId}`;
      expect(
        externalReplayCloudReadBatchMock.mock.calls.filter(
          ([options]) => options.token === token
        )
      ).toHaveLength(1);
    }

    engine.stop();
    await Promise.resolve();
    await Promise.resolve();
    for (const sessionId of sessionIds) {
      expect(
        externalReplayCloudReleaseMock.mock.calls.filter(
          ([token]) => token === `nine-spool-${sessionId}`
        )
      ).toHaveLength(1);
    }
  });

  it("publishes a tail-only external spool without treating the tail as frozen", async () => {
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "tail-only-external-spool",
      generation: "g1",
      totalCount: 1,
      frozenEventCount: 0,
      tailEventCount: 1,
      frozenChainHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tailHash: "tail-hash",
    });
    externalReplayCloudReadBatchMock.mockResolvedValueOnce({
      segments: [
        {
          payloadGz: "tail-wire",
          eventCount: 1,
          segmentHash: "tail-hash",
          wireBytes: 100,
        },
      ],
      startEventIndex: 0,
      nextEventIndex: 1,
      startSegmentIndex: 0,
      nextSegmentIndex: 1,
      eof: true,
      serializedBytes: 100,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    const rewrite = client.rewriteSessionEventWires.mock.calls[0]?.[1];
    expect(rewrite?.frozenSegments).toEqual([]);
    expect(rewrite?.tail).toMatchObject({
      payloadGz: "tail-wire",
      eventCount: 1,
      segmentHash: "tail-hash",
    });
    expect(rewrite?.totalCount).toBe(1);
  });

  it("re-anchors an external staged rewrite after a bounded append conflict", async () => {
    const events = [makeEvent("x1"), makeEvent("x2")];
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "conflict-external-spool",
      generation: "g1",
      totalCount: 2,
      frozenEventCount: 2,
      tailEventCount: 0,
      frozenChainHash: "chain-2",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments:
          startEventIndex < endEventIndex
            ? [
                {
                  payloadGz: `wire-${events[startEventIndex]?.id}`,
                  eventCount: 1,
                  segmentHash: `hash-${events[startEventIndex]?.id}`,
                  wireBytes: 100,
                },
              ]
            : [],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    client.rewriteSessionEventWires.mockRejectedValueOnce(conflictError());
    client.getSessionEvents.mockResolvedValueOnce({
      epoch: 7,
      frozenSeq: 0,
      tailHash: null,
      count: 0,
      segments: [],
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(client.getSessionEvents).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      "cursoride-thread-1",
      expect.objectContaining({
        boundedWirePage: true,
        cursor: { direction: "backward" },
        includeTail: false,
        maxSegments: 1,
        maxWireBytes: 64 * 1024,
        signal: expect.any(AbortSignal),
      })
    );
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(2);
    expect(client.rewriteSessionEventWires.mock.calls[1]?.[1].newEpoch).toBe(8);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({ epoch: 8, frozenEventCount: 2, pushedCount: 2 });
  });

  it("rewrites a new epoch when an external source shrinks", async () => {
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:cursoride-thread-1": {
        orgId: "corg-1",
        sessionId: "cursoride-thread-1",
        epoch: 4,
        frozenSeq: 3,
        pushedCount: 3,
        frozenEventCount: 3,
        frozenChainHash: "old-chain",
        tailHash: null,
      },
    });
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "shrunk-external-spool",
      generation: "g2",
      totalCount: 2,
      frozenEventCount: 2,
      tailEventCount: 0,
      frozenChainHash: "new-chain",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockResolvedValueOnce({
      segments: [
        {
          payloadGz: "wire-new-1",
          eventCount: 1,
          segmentHash: "hash-new-1",
          wireBytes: 100,
        },
        {
          payloadGz: "wire-new-2",
          eventCount: 1,
          segmentHash: "hash-new-2",
          wireBytes: 100,
        },
      ],
      startEventIndex: 0,
      nextEventIndex: 2,
      startSegmentIndex: 0,
      nextSegmentIndex: 2,
      eof: true,
      serializedBytes: 200,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrefixHashMock).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(client.rewriteSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEventWires.mock.calls[0]?.[1]).toMatchObject({
      newEpoch: 5,
      totalCount: 2,
      frozenSegments: [
        { seq: 1, eventCount: 1 },
        { seq: 2, eventCount: 1 },
      ],
    });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({
      epoch: 5,
      frozenSeq: 2,
      pushedCount: 2,
      frozenEventCount: 2,
      frozenChainHash: "new-chain",
    });
  });

  it("rewrites an empty epoch when an external source is cleared", async () => {
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:cursoride-thread-1": {
        orgId: "corg-1",
        sessionId: "cursoride-thread-1",
        epoch: 4,
        frozenSeq: 3,
        pushedCount: 3,
        frozenEventCount: 3,
        frozenChainHash: "old-chain",
        tailHash: null,
      },
    });
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "cleared-external-spool",
      generation: "g2",
      totalCount: 0,
      frozenEventCount: 0,
      tailEventCount: 0,
      frozenChainHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tailHash: null,
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();

    expect(externalReplayCloudPrefixHashMock).not.toHaveBeenCalled();
    expect(externalReplayCloudReadBatchMock).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(client.rewriteSessionEventWires).toHaveBeenCalledWith("jwt-1", {
      orgId: "corg-1",
      sessionId: "cursoride-thread-1",
      newEpoch: 5,
      frozenSegments: [],
      tail: null,
      totalCount: 0,
    });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toMatchObject({
      epoch: 5,
      frozenSeq: 0,
      pushedCount: 0,
      frozenEventCount: 0,
      tailHash: null,
    });
  });

  it("stops an external multi-batch rewrite before publishing a partial epoch", async () => {
    externalReplayCloudPrepareMock.mockResolvedValueOnce({
      token: "abort-external-spool",
      generation: "g1",
      totalCount: 3,
      frozenEventCount: 3,
      tailEventCount: 0,
      frozenChainHash: "chain-3",
      tailHash: null,
    });
    externalReplayCloudReadBatchMock.mockImplementation(
      async ({ startEventIndex, endEventIndex }) => ({
        segments: [
          {
            payloadGz: `wire-${startEventIndex}`,
            eventCount: 1,
            segmentHash: `hash-${startEventIndex}`,
            wireBytes: 100,
          },
        ],
        startEventIndex,
        nextEventIndex: Math.min(startEventIndex + 1, endEventIndex),
        startSegmentIndex: startEventIndex,
        nextSegmentIndex: startEventIndex + 1,
        eof: startEventIndex + 1 >= endEventIndex,
        serializedBytes: 100,
      })
    );
    client.uploadSessionEventWires.mockImplementationOnce(async () => {
      engine.stop();
      return [
        {
          seq: 1,
          storagePath: "corg-1/cursoride-thread-1/1/1-hash-0.gz",
          eventCount: 1,
          segmentHash: "hash-0",
        },
      ];
    });
    store.set(sessionsAtom, [
      { ...SESSION, session_id: "cursoride-thread-1", orgId: "personal-org" },
    ]);

    await engine.runSyncPass();
    vi.setSystemTime(Date.now() + EXTERNAL_HISTORY_ACTIVITY_DEBOUNCE_MS + 1);
    await engine.runSyncPass();
    await Promise.resolve();
    await Promise.resolve();

    expect(client.uploadSessionEventWires).toHaveBeenCalledTimes(1);
    expect(client.rewriteSessionEventWires).not.toHaveBeenCalled();
    expect(client.appendSessionEventWires).not.toHaveBeenCalled();
    expect(externalReplayCloudReadBatchMock).toHaveBeenCalledTimes(1);
    expect(externalReplayCloudReleaseMock).toHaveBeenCalledWith(
      "abort-external-spool"
    );
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:cursoride-thread-1"]
    ).toBeUndefined();
  });

  // --- deleteSession resurrection-hash fix ----------------------------------
});
