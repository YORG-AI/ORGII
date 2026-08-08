import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { MetadataCells } from "./MetadataCells";

vi.mock("./ProjectCell", () => ({
  ProjectCell: () =>
    React.createElement("span", { "data-testid": "project-cell" }),
}));

const workItem = {
  session_id: "issue-1",
  name: "Issue",
  project: { id: "project-1", name: "ORGII issues" },
  labels: [{ id: "label-1", name: "bug", color: "#ef4444" }],
} as WorkItem;

function renderMetadata(hideProjectCell: boolean) {
  return renderToStaticMarkup(
    React.createElement(MetadataCells, {
      workItem,
      compact: false,
      availableProjects: [],
      hideProjectCell,
      t: (key: string) => key,
    })
  );
}

describe("MetadataCells", () => {
  it("hides fixed project identity without hiding labels", () => {
    const markup = renderMetadata(true);

    expect(markup).not.toContain('data-testid="project-cell"');
    expect(markup).toContain("bug");
  });

  it("keeps project identity in lists that are not fixed to one project", () => {
    expect(renderMetadata(false)).toContain('data-testid="project-cell"');
  });
});
