/**
 * Retention parking on the push loop.
 *
 * A session past the org's retention window fails its push with
 * ORG2_RETENTION_EXPIRED on every pass; retention only recedes further
 * within a signed-in run, so the engine must stop re-walking the doomed
 * upload chain instead of retrying it each pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Org2CloudSyncError } from "./org2CloudSyncClient";
import {
  cleanupEngineFixture,
  createEngineFixture,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";
import {
  getSyncJournalSnapshot,
  resetSyncJournalForTests,
} from "./org2CloudSyncJournal";

describe("Org2CloudSyncEngine retention parking", () => {
  let fixture: EngineFixture;
  let engine: EngineFixture["engine"];

  beforeEach(() => {
    resetSyncJournalForTests();
    fixture = createEngineFixture();
    ({ engine } = fixture);
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
    resetSyncJournalForTests();
  });

  it("parks a retention-expired session instead of retrying every pass", async () => {
    fixture.client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_RETENTION_EXPIRED", 400)
    );

    await engine.runSyncPass();
    expect(fixture.client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
    expect(
      getSyncJournalSnapshot().some(
        (event) =>
          event.kind === "session_retention_parked" &&
          event.code === "ORG2_RETENTION_EXPIRED"
      )
    ).toBe(true);

    await engine.runSyncPass();
    expect(fixture.client.upsertSessionMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying pushes that fail with other codes", async () => {
    fixture.client.upsertSessionMetadata.mockRejectedValue(
      new Org2CloudSyncError("ORG2_VALIDATION", 400)
    );

    await engine.runSyncPass();
    await engine.runSyncPass();
    expect(fixture.client.upsertSessionMetadata).toHaveBeenCalledTimes(2);
  });
});
