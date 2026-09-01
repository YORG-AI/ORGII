import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FolderClosedIcon } from "@src/icons";

import { WorkstationSections } from "./WorkstationSections";
import type { FocusedChatRailSection } from "./types";

const sections: FocusedChatRailSection[] = [
  {
    key: "session",
    label: null,
    environment: { repoName: "session-repository" },
    items: [],
  },
  {
    key: "workspace",
    label: "Local Environment",
    environment: { repoName: "local-repository" },
    items: [
      {
        key: "files",
        label: "Files",
        icon: FolderClosedIcon,
      },
    ],
  },
  {
    key: "tabs",
    label: "Open Tabs",
    items: [
      {
        key: "open-file",
        label: "README.md",
        icon: FolderClosedIcon,
      },
    ],
  },
];

describe("WorkstationSections", () => {
  it("collapses only the selected wide-rail group and preserves its heading", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationSections, {
        collapseGroupLabel: "Collapse",
        collapsedGroupKeys: new Set(["workspace"]),
        expandGroupLabel: "Expand",
        onToggleGroup: () => {},
        sections,
      })
    );

    expect(markup).toContain("session-repository");
    expect(markup).toContain("Local Environment");
    expect(markup).not.toContain("local-repository");
    expect(markup).not.toContain("Files");
    expect(markup).toContain("Open Tabs");
    expect(markup).toContain("README.md");
    expect(markup).toContain('data-workstation-group-toggle="workspace"');
    expect(markup).toContain('data-workstation-group-toggle="tabs"');
    expect(markup).toContain('data-icon="chevron-right"');
    expect(markup).toContain('data-icon="chevron-down"');
  });

  it("folds compact-menu groups behind their clickable headings", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationSections, {
        compact: true,
        collapseGroupLabel: "Collapse",
        collapsedGroupKeys: new Set(["session", "workspace", "tabs"]),
        expandGroupLabel: "Expand",
        onToggleGroup: () => {},
        sections,
      })
    );

    // The unlabelled session group leaves no empty spacer when folded.
    expect(markup).not.toContain("session-repository");
    expect(markup).toContain("Local Environment");
    expect(markup).not.toContain("local-repository");
    expect(markup).not.toContain("Files");
    expect(markup).toContain("Open Tabs");
    expect(markup).not.toContain("README.md");
    expect(markup).toContain('role="menu"');
    expect(markup).toContain('data-workstation-group-toggle="workspace"');
    expect(markup).toContain('data-workstation-group-toggle="tabs"');
    expect(markup).toContain('data-icon="chevron-right"');
  });

  it.each([false, true])(
    "folds a collapsible section behind its heading (compact: %s)",
    (compact) => {
      const collapsibleSections: FocusedChatRailSection[] = [
        ...sections,
        {
          key: "subagents",
          label: "Subagents",
          items: [
            {
              key: "subagent:child",
              label: "Scan the changelog",
              icon: FolderClosedIcon,
            },
          ],
        },
      ];

      const collapsedMarkup = renderToStaticMarkup(
        createElement(WorkstationSections, {
          compact,
          collapseGroupLabel: "Collapse",
          collapsedGroupKeys: new Set(["subagents"]),
          expandGroupLabel: "Expand",
          onToggleGroup: () => {},
          sections: collapsibleSections,
        })
      );
      expect(collapsedMarkup).toContain("Subagents");
      expect(collapsedMarkup).not.toContain("Scan the changelog");
      expect(collapsedMarkup).toContain(
        'data-workstation-group-toggle="subagents"'
      );
      expect(collapsedMarkup).toContain('aria-expanded="false"');

      const expandedMarkup = renderToStaticMarkup(
        createElement(WorkstationSections, {
          compact,
          collapseGroupLabel: "Collapse",
          collapsedGroupKeys: new Set<string>(),
          expandGroupLabel: "Expand",
          onToggleGroup: () => {},
          sections: collapsibleSections,
        })
      );
      expect(expandedMarkup).toContain("Scan the changelog");
    }
  );
});
