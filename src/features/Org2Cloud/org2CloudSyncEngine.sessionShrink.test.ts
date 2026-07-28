import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupEngineFixture,
  createEngineFixture,
  engineTestDeps,
  eventStoreMock,
  makeEvent,
  notifySessionEvents,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const { org2CloudPushCursorsAtom } = engineTestDeps;

describe("Org2CloudSyncEngine persistent-shrink re-anchor", () => {
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

  it("skips a single short read without rewriting or moving the cursor", async () => {
    await engine.runSyncPass();
    const anchored = store.get(org2CloudPushCursorsAtom)["corg-1:session-1"];
    expect(anchored).toMatchObject({ epoch: 1, pushedCount: 2 });

    eventStoreMock.getPersistedEvents.mockResolvedValue([makeEvent("e1")]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).not.toHaveBeenCalled();
    expect(store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]).toEqual(
      anchored
    );
  });

  it("re-anchors via epoch rewrite after two consecutive identical short reads", async () => {
    await engine.runSyncPass();
    eventStoreMock.getPersistedEvents.mockResolvedValue([makeEvent("e1")]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(2);
    expect(client.getSessionEvents).not.toHaveBeenCalled();
    const [, rewrite] = client.rewriteSessionEvents.mock.calls[1];
    expect(rewrite).toMatchObject({
      orgId: "corg-1",
      sessionId: "session-1",
      newEpoch: 2,
      totalCount: 1,
    });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      epoch: 2,
      pushedCount: 1,
      frozenEventCount: 1,
    });

    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e3", "running"),
    ]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(2);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    const [, append] = client.appendSessionEvents.mock.calls[0];
    expect(append).toMatchObject({ expectedEpoch: 2, totalCount: 2 });
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      epoch: 2,
      pushedCount: 2,
    });
  });

  it("a full-length read between short reads resets the confirmation counter", async () => {
    await engine.runSyncPass();
    eventStoreMock.getPersistedEvents.mockResolvedValue([makeEvent("e1")]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();
    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);

    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent("e1"),
      makeEvent("e2"),
      makeEvent("e3", "running"),
    ]);
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      epoch: 1,
      pushedCount: 3,
    });

    eventStoreMock.getPersistedEvents.mockResolvedValue([makeEvent("e1")]);
    notifySessionEvents("session-1");
    await engine.runSyncPass();

    expect(client.rewriteSessionEvents).toHaveBeenCalledTimes(1);
    expect(client.appendSessionEvents).toHaveBeenCalledTimes(1);
    expect(
      store.get(org2CloudPushCursorsAtom)["corg-1:session-1"]
    ).toMatchObject({
      epoch: 1,
      pushedCount: 3,
    });
  });
});
