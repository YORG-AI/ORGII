import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "@src/types/core/project";

import ProjectRow from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type }: { type: string }) =>
    React.createElement("svg", { "data-integration-icon": type }),
}));

const project: Project = {
  id: "project-1",
  name: "GitHub Project",
  description: "从 yorgai/ORGII 的 GitHub Issues 同步。",
  slug: "github-project",
  syncAdapterId: "github",
  status: "backlog",
  priority: "none",
  health: "no_updates",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function renderProjectRow(nextProject: Project, onUnlinkSource?: () => void) {
  return renderToStaticMarkup(
    React.createElement(ProjectRow, {
      project: nextProject,
      isSelected: false,
      onSelect: vi.fn(),
      onUnlinkSource,
    })
  );
}

describe("ProjectRow source UI", () => {
  it("uses the project icon and preserves source actions for GitHub projects", () => {
    const markup = renderProjectRow(project, vi.fn());

    expect(markup).toContain('data-project-source-icon="github"');
    expect(markup).toContain('data-icon="box"');
    expect(markup).not.toContain('data-integration-icon="github"');
    expect(markup).toContain('data-testid="project-unlink-source-project-1"');
    expect(markup).toContain("GitHub Issues · yorgai/ORGII");
    expect(markup).not.toContain("同步。");
  });

  it("keeps the local project icon and omits unlink for local projects", () => {
    const markup = renderProjectRow({
      ...project,
      id: "local-project",
      syncAdapterId: undefined,
    });

    expect(markup).toContain('data-project-source-icon="local"');
    expect(markup).toContain('data-icon="box"');
    expect(markup).not.toContain('data-integration-icon="github"');
    expect(markup).not.toContain("project-unlink-source-local-project");
  });
});
