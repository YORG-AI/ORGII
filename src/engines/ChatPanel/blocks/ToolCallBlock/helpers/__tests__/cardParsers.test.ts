import { describe, expect, it } from "vitest";

import { parseContextImportCardResult } from "../cardParsers";

describe("parseContextImportCardResult", () => {
  it("builds source chips and cache debug stats from import_context result", () => {
    const card = parseContextImportCardResult(
      {
        source_kind: "session",
        source_id: "source-session",
        title: "Source Session",
        token_estimate: 321,
        pinned: true,
      },
      {
        snapshot_id: "snapshot-1234567890",
        namespace: "session:source-session",
        stable_prefix_tokens: 1200,
        volatile_context_tokens: 340,
        imported_context_count: 2,
        cache_read_tokens: 900,
        cache_write_tokens: 100,
      }
    );

    expect(card).toMatchObject({
      snapshotId: "snapshot-1234567890",
      sourceKind: "session",
      sourceId: "source-session",
      namespace: "session:source-session",
      title: "Source Session",
      tokenEstimate: 321,
      pinned: true,
      sourceChips: ["session:source-session", "session", "pinned"],
    });
    expect(card?.debugStats).toEqual([
      { label: "stable prefix", value: "1200" },
      { label: "volatile", value: "340" },
      { label: "imports", value: "2" },
      { label: "cache read", value: "900" },
      { label: "cache write", value: "100" },
    ]);
  });

  it("keeps explicit imports parseable when backend only returns minimal metadata", () => {
    const card = parseContextImportCardResult(
      { source_kind: "work_item", source_id: "WI-7" },
      {}
    );

    expect(card).toMatchObject({
      sourceKind: "work_item",
      sourceId: "WI-7",
      namespace: "work_item:WI-7",
      sourceChips: ["work_item:WI-7", "work item"],
    });
    expect(card?.debugStats).toBeUndefined();
  });
});
