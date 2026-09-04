// @vitest-environment jsdom
import { Provider } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ORCHESTRATOR_CONFIG } from "@src/modules/ProjectManager/WorkItems/constants";

import StartPageWorkItemComposerChrome from "./StartPageWorkItemComposerChrome";

const mocks = vi.hoisted(() => ({
  updateDraft: vi.fn(),
}));

vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView/InlineCreateWorkItemFields",
  () => ({
    useInlineCreateWorkItemFields: () => ({
      draft: {
        name: "",
        description: "",
        status: "todo",
        priority: "medium",
        labelIds: [],
      },
      inlinePropertyPills: "properties",
      titleSection: "title",
      updateDraft: mocks.updateDraft,
      workItemProjectPill: "project",
    }),
  })
);

describe("StartPageWorkItemComposerChrome", () => {
  let container: HTMLDivElement;
  let headerHost: HTMLDivElement;
  let pinnedActionsHost: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    headerHost = document.createElement("div");
    pinnedActionsHost = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("portals Work Item-only controls into the persistent composer", () => {
    act(() => {
      root.render(
        createElement(
          Provider,
          null,
          createElement(StartPageWorkItemComposerChrome, {
            creatorModeControl: createElement("span", null, "mode"),
            defaultAiWorkItemExecutionTarget: {
              id: "agent-1",
              name: "Agent",
              type: "agent",
              agentDefinitionId: "agent-def-1",
            },
            headerHost,
            onDraftChange: vi.fn(),
            pinnedActionsHost,
          })
        )
      );
    });

    expect(headerHost.textContent).toContain("title");
    expect(pinnedActionsHost.textContent).toContain("mode");
    expect(pinnedActionsHost.textContent).toContain("project");
    expect(pinnedActionsHost.textContent).toContain("properties");
    expect(mocks.updateDraft).toHaveBeenCalledWith({
      orchestratorConfig: {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        agent_definition_id: "agent-def-1",
        org_id: undefined,
      },
    });
  });
});
