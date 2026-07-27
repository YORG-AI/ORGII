import { describe, expect, it } from "vitest";

import { org2CloudAccessSettingsAtom } from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { inheritCloudShareLadderForFork } from "./collabSessionFork";

const ORG = "corg-1";
const SOURCE = "claudecodeapp-source-1";
const FORK = "agentsession-fork-1";

function storeWithSettings(
  sessionModes: Record<string, "off" | "metadata_only" | "full_replay">,
  sessionVisibility: Record<string, "org" | "restricted"> = {}
) {
  const store = createInstrumentedStore();
  store.set(org2CloudAccessSettingsAtom, {
    [ORG]: { sessionModes, sessionVisibility },
  });
  return store;
}

describe("inheritCloudShareLadderForFork", () => {
  it("copies the source's explicit share mode and visibility to the fork", () => {
    const store = storeWithSettings(
      { [SOURCE]: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY },
      { [SOURCE]: "restricted" }
    );

    inheritCloudShareLadderForFork(store, ORG, SOURCE, FORK);

    const settings = store.get(org2CloudAccessSettingsAtom)[ORG];
    expect(settings.sessionModes[FORK]).toBe(
      COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
    );
    expect(settings.sessionVisibility[FORK]).toBe("restricted");
    expect(settings.sessionModes[SOURCE]).toBe(
      COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
    );
  });

  it("leaves settings untouched when the source has no explicit entry", () => {
    const store = storeWithSettings({});
    const before = store.get(org2CloudAccessSettingsAtom);

    inheritCloudShareLadderForFork(store, ORG, SOURCE, FORK);

    expect(store.get(org2CloudAccessSettingsAtom)).toBe(before);
  });

  it("does not copy an explicit OFF override", () => {
    const store = storeWithSettings({
      [SOURCE]: COLLAB_SESSION_ACCESS_MODE.OFF,
    });

    inheritCloudShareLadderForFork(store, ORG, SOURCE, FORK);

    const settings = store.get(org2CloudAccessSettingsAtom)[ORG];
    expect(settings.sessionModes[FORK]).toBeUndefined();
  });
});
