/**
 * Tagged-org visiting on the session push pass.
 *
 * Move to Org tags a session into an org the user may not be looking at.
 * The pass must visit such an org anyway — filtering it out at the
 * sessionPushOrgs stage made the dialog's awaited pass complete without
 * touching the target org, report success, and leave the session invisible
 * to every other member (and its later updates unsynced) until the owner
 * happened to activate that org.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionOrgTagsAtom } from "../TeamCollaboration/sessionOrgTagsAtom";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "./org2CloudSyncAtoms";
import {
  cleanupEngineFixture,
  createEngineFixture,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

describe("Org2CloudSyncEngine tagged-org visiting", () => {
  let fixture: EngineFixture;
  let engine: EngineFixture["engine"];

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ engine } = fixture);
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
  });

  it("pushes a tagged session to an inactive org without background upload", async () => {
    const { store, client } = fixture;
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);
    store.set(org2CloudRepoScopesAtom, (current) => ({
      ...current,
      "corg-2": current["corg-1"] ?? [],
    }));
    store.set(sessionOrgTagsAtom, {
      "session-1": ["cloud:corg-2"],
    });

    await engine.runSyncPass();

    const orgsUpserted = client.upsertSessionMetadata.mock.calls.map(
      (call) => call[1]
    );
    expect(orgsUpserted).toContain("corg-2");
  });

  it("still skips untagged inactive orgs without background upload", async () => {
    const { store, client } = fixture;
    store.set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
      { orgId: "corg-2", name: "Other Team", role: "member" },
    ]);

    await engine.runSyncPass();

    const orgsUpserted = client.upsertSessionMetadata.mock.calls.map(
      (call) => call[1]
    );
    expect(orgsUpserted).not.toContain("corg-2");
  });
});
