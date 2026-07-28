import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCOPE_KEY,
  SESSION,
  cleanupEngineFixture,
  createEngineFixture,
  engineTestDeps,
} from "./org2CloudSyncEngine.testUtils";
import type { EngineFixture } from "./org2CloudSyncEngine.testUtils";

const {
  cloudOrgToken,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  sessionOrgTagsAtom,
  sessionsAtom,
} = engineTestDeps;

describe("scope-driven retract requires server-confirmed scopes", () => {
  let fixture: EngineFixture;
  let store: EngineFixture["store"];
  let client: EngineFixture["client"];
  let engine: EngineFixture["engine"];

  beforeEach(() => {
    fixture = createEngineFixture();
    ({ store, client, engine } = fixture);
    // A previously-pushed, tagged session whose persisted scope mirror is
    // empty — the exact boot state that mass-retracted live rows.
    store.set(sessionsAtom, [SESSION]);
    store.set(sessionOrgTagsAtom, {
      [SESSION.session_id]: [cloudOrgToken("corg-1")],
    });
    store.set(org2CloudPushedMetadataAtom, {
      [`corg-1:${SESSION.session_id}`]: true,
    });
    store.set(org2CloudRepoScopesAtom, { "corg-1": [] });
  });

  afterEach(() => {
    cleanupEngineFixture(engine);
  });

  it("does not retract or untag while the scope fetch keeps failing", async () => {
    client.getOrgRepoScopes.mockRejectedValue(new Error("offline"));

    await engine.runSyncPass();

    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(store.get(sessionOrgTagsAtom)[SESSION.session_id]).toEqual([
      cloudOrgToken("corg-1"),
    ]);
  });

  it("retracts once the server confirms the session is genuinely out of scope", async () => {
    client.getOrgRepoScopes.mockResolvedValue({
      repoScopes: ["github.com/other/repo"],
      used: 1,
      cap: null,
      cooldownDays: 0,
      coolingDown: [],
    });

    await engine.runSyncPass();

    expect(client.deleteSession).toHaveBeenCalledWith(
      "jwt-1",
      "corg-1",
      SESSION.session_id
    );
    expect(store.get(sessionOrgTagsAtom)[SESSION.session_id] ?? []).toEqual([]);
  });

  it("keeps pushing in-scope sessions on a confirmed fetch", async () => {
    client.getOrgRepoScopes.mockResolvedValue({
      repoScopes: [SCOPE_KEY],
      used: 1,
      cap: null,
      cooldownDays: 0,
      coolingDown: [],
    });

    await engine.runSyncPass();

    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(client.upsertSessionMetadata).toHaveBeenCalled();
  });
});
