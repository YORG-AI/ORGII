import { describe, expect, it } from "vitest";

import {
  cloudSessionEventTarget,
  matchesWebSessionPath,
  webSessionHasOpenNotes,
  webSessionPath,
} from "./webSessionLocation";

const session = {
  id: "org:user:session-row",
  orgId: "org/one",
  sourceSessionId: "agentsession-local",
};

describe("Web cloud session identity", () => {
  it("uses the authoritative remote row id for event fetches", () => {
    expect(cloudSessionEventTarget(session)).toEqual({
      orgId: "org/one",
      sessionRowId: "org:user:session-row",
    });
  });

  it("uses the same row id for encoded routes and matching", () => {
    expect(webSessionPath(session)).toBe(
      "/sessions/org%2Fone/org%3Auser%3Asession-row"
    );
    expect(webSessionPath(session, { openNotes: true })).toBe(
      "/sessions/org%2Fone/org%3Auser%3Asession-row?notes=1"
    );
    expect(
      matchesWebSessionPath(session, "org/one", "org:user:session-row")
    ).toBe(true);
    expect(
      matchesWebSessionPath(session, "org/one", "agentsession-local")
    ).toBe(false);
  });
});

describe("webSessionHasOpenNotes", () => {
  it("detects notes=1 search param", () => {
    expect(webSessionHasOpenNotes("?notes=1")).toBe(true);
    expect(webSessionHasOpenNotes("")).toBe(false);
  });
});
