import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";

import type { KanbanOrgScope } from "./useKanbanOrgScope";
import {
  resolveKanbanTaskCreator,
  sessionMatchesKanbanOrgScope,
} from "./useKanbanOrgScope";

function scope(overrides: Partial<KanbanOrgScope> = {}): KanbanOrgScope {
  return {
    selectedOrgId: "cloud:org-1",
    selectedOrgIds: new Set(["cloud:org-1", "org-1"]),
    currentCreator: {
      id: "user-me",
      name: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    },
    ...overrides,
  };
}

describe("sessionMatchesKanbanOrgScope", () => {
  it("matches bare cloud ownership and explicitly included scoped sessions", () => {
    const orgScope = scope({ extraSessionIds: new Set(["tagged"]) });

    expect(
      sessionMatchesKanbanOrgScope(
        { session_id: "owned", orgId: "org-1" },
        orgScope
      )
    ).toBe(true);
    expect(
      sessionMatchesKanbanOrgScope(
        { session_id: "tagged", orgId: undefined },
        orgScope
      )
    ).toBe(true);
    expect(
      sessionMatchesKanbanOrgScope(
        { session_id: "personal", orgId: undefined },
        orgScope
      )
    ).toBe(false);
  });

  it("honors the Personal exclusion even when ownership otherwise matches", () => {
    const personalScope = scope({
      selectedOrgId: DEFAULT_SESSION_ORG_ID,
      selectedOrgIds: new Set([DEFAULT_SESSION_ORG_ID]),
      excludedSessionIds: new Set(["moved"]),
    });

    expect(
      sessionMatchesKanbanOrgScope(
        { session_id: "personal", orgId: undefined },
        personalScope
      )
    ).toBe(true);
    expect(
      sessionMatchesKanbanOrgScope(
        { session_id: "moved", orgId: undefined },
        personalScope
      )
    ).toBe(false);
  });
});

describe("resolveKanbanTaskCreator", () => {
  it("uses persisted import provenance for a teammate session", () => {
    expect(
      resolveKanbanTaskCreator(
        {
          importedFrom: {
            orgId: "org-1",
            sourceSessionId: "source-1",
            ownerMemberId: "user-grace",
            ownerDisplayName: "Grace Hopper",
            ownerAvatarUrl: "https://example.com/grace.png",
            epoch: 1,
            seq: 2,
            count: 3,
          },
        },
        scope()
      )
    ).toEqual({
      id: "user-grace",
      name: "Grace Hopper",
      avatarUrl: "https://example.com/grace.png",
    });
  });

  it("uses the current profile for an owned org session", () => {
    expect(resolveKanbanTaskCreator({}, scope())).toEqual({
      id: "user-me",
      name: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    });
  });

  it("does not add creator chrome in Personal scope", () => {
    expect(
      resolveKanbanTaskCreator(
        {},
        scope({
          selectedOrgId: DEFAULT_SESSION_ORG_ID,
          selectedOrgIds: new Set([DEFAULT_SESSION_ORG_ID]),
        })
      )
    ).toBeUndefined();
  });
});
