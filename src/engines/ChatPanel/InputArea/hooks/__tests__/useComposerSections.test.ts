import React from "react";
import { describe, expect, it, vi } from "vitest";

import DiffStatsBadge from "@src/components/DiffStatsBadge";

import { createFileInlineSection } from "../useComposerSections";

describe("createFileInlineSection", () => {
  it("uses the shared DiffStatsBadge for additions and deletions", () => {
    const section = createFileInlineSection({
      fileChangeStats: { count: 2, additions: 7, deletions: 3 },
      onFilesExpand: vi.fn(),
    });
    const content = section?.content as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const children = React.Children.toArray(content.props.children);
    const badge = children[2] as React.ReactElement;

    expect(badge.type).toBe(DiffStatsBadge);
    expect(badge.props).toMatchObject({
      additions: 7,
      deletions: 3,
      variant: "plain",
      reserveValueWidth: false,
    });
  });

  it("omits the separator and badge when both line stats are zero", () => {
    const section = createFileInlineSection({
      fileChangeStats: { count: 1, additions: 0, deletions: 0 },
      onFilesExpand: vi.fn(),
    });
    const content = section?.content as React.ReactElement<{
      children: React.ReactNode;
    }>;

    expect(React.Children.toArray(content.props.children)).toHaveLength(1);
  });
});
