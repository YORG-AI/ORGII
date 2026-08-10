import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import PinnedTurnHeader from "../PinnedTurnHeader";

vi.mock("../../renderers/GroupHeaderRenderer", () => ({
  GroupHeaderRenderer: () => <div data-testid="group-header" />,
}));

describe("PinnedTurnHeader exact durable target", () => {
  it("marks the actual pinned user header instead of the paginated list placeholder", () => {
    const markup = renderToStaticMarkup(
      <PinnedTurnHeader
        visible
        sourceGroupIndex={3}
        sourceGroupCount={4}
        header={
          {
            chunk_id: "user-anchor",
            type: "activity",
            event: { id: "user-anchor" },
          } as never
        }
        meta={undefined}
        collapseTailWhenIdle={false}
        hideUserMessage={false}
        defaultTurnCollapsed={false}
        turnCollapseInteractionAtRef={{ current: 0 }}
        onEditSubmit={undefined}
        onRestoreCheckpoint={undefined}
        exactHistoryTarget
      />
    );

    expect(markup).toContain('data-exact-history-target="true"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('aria-label="Exact history target"');
  });
});
