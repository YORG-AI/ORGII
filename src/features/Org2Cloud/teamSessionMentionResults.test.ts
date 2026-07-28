import { describe, expect, it } from "vitest";

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { parseCloudSessionReference } from "./cloudSessionReference";
import { teamSessionMentionResults } from "./teamSessionMentionResults";

const ORG = "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd";
const MATE = "6c6a39b1-4ca5-4c48-89b4-74d1565c258d";
const SELF = "394af2b7-bccd-4561-9fe0-df19d26538bd";

function row(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "row",
    orgId: ORG,
    ownerUserId: MATE,
    ownerDisplayName: "junyu",
    sourceSessionId: "codexapp-1",
    title: "查看未提交变动",
    eventsEpoch: 3,
    ...overrides,
  } as RemoteTeammateSessionMetadata;
}

function run(
  rows: RemoteTeammateSessionMetadata[] | undefined,
  query = "",
  localSessionIds = new Set<string>()
) {
  return teamSessionMentionResults({
    query,
    rows,
    selfUserId: SELF,
    localSessionIds,
  });
}

describe("teamSessionMentionResults", () => {
  it("offers a teammate row keyed by its full reference", () => {
    const [item] = run([row()]);
    expect(item.iconType).toBe("cloudSession");
    expect(item.name).toBe("查看未提交变动");
    expect(item.repoName).toBe("junyu");
    const parsed = parseCloudSessionReference(item.path);
    expect(parsed).toMatchObject({
      orgId: ORG,
      ownerUserId: MATE,
      sourceSessionId: "codexapp-1",
    });
  });

  it("returns nothing when no listing is cached", () => {
    // Opening the menu must not fetch, so an unlisted org simply has no
    // team candidates rather than triggering a request.
    expect(run(undefined)).toEqual([]);
    expect(run([])).toEqual([]);
  });

  it("matches on title and on owner", () => {
    expect(run([row()], "未提交")).toHaveLength(1);
    expect(run([row()], "junyu")).toHaveLength(1);
    expect(run([row()], "nothing like this")).toHaveLength(0);
  });

  it("hides rows that cannot be opened", () => {
    expect(run([row({ deletedAt: "2026-07-27T00:00:00Z" })])).toHaveLength(0);
    expect(run([row({ eventsEpoch: undefined })])).toHaveLength(0);
  });

  it("skips the viewer's own row when it already exists locally", () => {
    const own = row({ ownerUserId: SELF, sourceSessionId: "mine-1" });
    expect(run([own], "", new Set(["mine-1"]))).toHaveLength(0);
    // Same session on another device has no local copy, so it stays.
    expect(run([own], "", new Set())).toHaveLength(1);
  });

  it("strips the fork glyph and truncates long titles", () => {
    const [item] = run([row({ title: "⑂ ⑂ short" })]);
    expect(item.name).toBe("short");
    const [long] = run([row({ title: "x".repeat(80) })]);
    expect(long.name).toHaveLength(50);
    expect(long.name?.endsWith("...")).toBe(true);
  });

  it("caps how many team rows crowd the menu", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      row({ id: `r${i}`, sourceSessionId: `s${i}` })
    );
    expect(run(many)).toHaveLength(10);
  });
});
