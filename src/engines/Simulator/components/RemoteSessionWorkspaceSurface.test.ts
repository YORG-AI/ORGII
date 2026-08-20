/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { RemoteSessionWorkspaceSurface } from "./RemoteSessionWorkspaceSurface";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock(
  "@src/modules/WorkStation/CodeEditor/SessionReplay/FileSidebar",
  () => ({
    FileSidebar: ({
      fileOperations,
      currentEventId,
    }: {
      fileOperations: Array<{ eventId: string; fileName: string }>;
      currentEventId: string;
    }) =>
      React.createElement(
        "aside",
        {
          "data-remote-file-sidebar": true,
          "data-current-event": currentEventId,
        },
        fileOperations.map((operation) =>
          React.createElement(
            "div",
            { key: operation.eventId, "data-file-op": operation.fileName },
            operation.fileName
          )
        )
      ),
  })
);

vi.mock("@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel", () => ({
  CodePanel: ({ operation }: { operation?: { fileName?: string } | null }) =>
    React.createElement(
      "div",
      { "data-remote-code-panel": true },
      operation?.fileName ?? "empty"
    ),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  buildPrimarySidebarConfig: (config: { content: React.ReactNode }) => config,
  WorkStationShell: ({
    primarySidebarConfig,
    content,
  }: {
    primarySidebarConfig: { content: React.ReactNode };
    content: React.ReactNode;
  }) => React.createElement("div", null, primarySidebarConfig.content, content),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: ({
    variant,
    title,
    subtitle,
  }: {
    variant: string;
    title?: string;
    subtitle?: string;
  }) =>
    React.createElement(
      "div",
      { "data-placeholder-variant": variant },
      title,
      subtitle
    ),
}));

function readEvent(content: string): SessionEvent {
  return {
    id: "read",
    chunk_id: "read",
    sessionId: "remote-session",
    createdAt: "2026-08-19T00:00:00.000Z",
    functionName: "read_file",
    uiCanonical: "read_file",
    actionType: "tool_call",
    args: { path: "/repo/src/app.ts" },
    result: {
      output: { success: { content } },
    },
    source: "assistant",
    displayText: "Read app.ts",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    repoPath: "/repo",
    extracted: {
      kind: "file",
      filePath: "/repo/src/app.ts",
      fileName: "app.ts",
      language: "typescript",
      content,
    },
  } as SessionEvent;
}

describe("RemoteSessionWorkspaceSurface", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("uses the desktop FileSidebar + CodePanel replay stack for event-backed files", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(RemoteSessionWorkspaceSurface, {
        events: [readEvent("export const ready = true;")],
        loadStatus: "loaded",
        loadError: null,
        currentEventId: "read",
      })
    );

    expect(
      root.container.querySelector("[data-remote-file-sidebar]")
    ).not.toBeNull();
    expect(
      root.container.querySelector("[data-remote-code-panel]")?.textContent
    ).toBe("app.ts");
    expect(
      root.container.querySelector("[data-file-op='app.ts']")
    ).not.toBeNull();
  });

  it("shows explicit empty and failure states instead of a blank editor", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(RemoteSessionWorkspaceSurface, {
        events: [],
        loadStatus: "loaded",
        loadError: null,
      })
    );
    expect(root.container.textContent).toContain(
      "web.sessionPage.workstationEmptyTitle"
    );

    await root.render(
      React.createElement(RemoteSessionWorkspaceSurface, {
        events: [],
        loadStatus: "loading",
        loadError: null,
      })
    );
    expect(
      root.container.querySelector("[data-placeholder-variant='loading']")
    ).not.toBeNull();
    expect(root.container.textContent).toContain(
      "web.sessionPage.workstationLoading"
    );
    expect(root.container.textContent).not.toContain("status.loading");

    await root.render(
      React.createElement(RemoteSessionWorkspaceSurface, {
        events: [],
        loadStatus: "error",
        loadError: "Cloud request failed",
      })
    );
    expect(
      root.container.querySelector("[data-placeholder-variant='error']")
    ).not.toBeNull();
    expect(root.container.textContent).toContain("Cloud request failed");
  });
});
