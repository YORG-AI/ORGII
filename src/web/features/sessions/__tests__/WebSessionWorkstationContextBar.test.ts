import { describe, expect, it } from "vitest";

import {
  hasWebSessionWorkstationContext,
  resolveWebSessionWorkstationContext,
} from "../WebSessionWorkstationContextBar";
import type { WebSessionListItem } from "../useWebSessionRoster";

function createSession(
  overrides: Partial<WebSessionListItem> = {}
): WebSessionListItem {
  return {
    id: "row-1",
    orgId: "org-1",
    orgName: "ORG2",
    writable: false,
    ownerMemberId: "member-1",
    ownerUserId: "user-1",
    ownerDisplayName: "Alex",
    ownerIdentityKind: "human",
    sourceSessionId: "source-1",
    title: "Session",
    eventsEpoch: 1,
    eventsFrozenSeq: 0,
    eventsCount: 0,
    eventsTailHash: "",
    ...overrides,
  };
}

describe("resolveWebSessionWorkstationContext", () => {
  it("projects repo and branch metadata from remote session fields", () => {
    const context = resolveWebSessionWorkstationContext(
      createSession({
        repoScopeKey: "github.com/acme/app.git",
        branch: "feature/web-chrome",
      })
    );

    expect(context.repoName).toBe("app");
    expect(context.branchName).toBe("feature/web-chrome");
    expect(hasWebSessionWorkstationContext(context)).toBe(true);
  });

  it("marks fork lineage without requiring repo metadata", () => {
    const context = resolveWebSessionWorkstationContext(
      createSession({
        forkedFrom: {
          sourceSessionId: "parent-1",
          rootSessionId: "root-1",
          ownerDisplayName: "Jordan",
        },
      })
    );

    expect(context.isFork).toBe(true);
    expect(context.ownerDisplayName).toBe("Alex");
    expect(hasWebSessionWorkstationContext(context)).toBe(true);
  });

  it("returns false when no workstation context is available", () => {
    expect(
      hasWebSessionWorkstationContext(
        resolveWebSessionWorkstationContext(createSession())
      )
    ).toBe(false);
  });
});
