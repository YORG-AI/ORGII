// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitFile } from "@src/types/git/types";

import type { SourceControlContentProps } from "../../content/SourceControlContent/types";
import {
  type SourceControlContentHandle,
  SourceControlTabContent,
  SourceControlWithWorktrees,
} from "../SourceControlTabPanels";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  renderContent: vi.fn(),
  refresh: vi.fn(async () => {}),
  select: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/api/tauri/repo", () => ({ repoApi: {} }));
vi.mock("@src/components/Message", () => ({ default: {} }));
vi.mock("@src/components/Placeholder", () => ({
  Placeholder: () => "loading-placeholder",
}));
vi.mock("../../hooks/useSourceControlState", () => ({
  useSourceControlState: mocks.state,
}));
vi.mock("../../content/WorktreeSourceControlSection", () => ({
  WorktreeSourceControlSection: () => "worktree",
}));
vi.mock("../../content/SourceControlContent", () => ({
  default: (props: SourceControlContentProps) => {
    mocks.renderContent(props);
    return createElement(
      "button",
      { onClick: () => props.onFileSelect("file-1") },
      props.selectedFileId || "unselected"
    );
  },
}));

const files: GitFile[] = [
  {
    id: "file-1",
    path: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    staged: false,
  },
];

describe.each(["standalone", "main-repo"] as const)(
  "%s Source Control pane",
  (host) => {
    let container: HTMLDivElement;
    let root: Root;
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };

    beforeEach(() => {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
      vi.clearAllMocks();
      mocks.state.mockReturnValue({
        loading: false,
        refresh: mocks.refresh,
        state: {
          files,
          filteredFiles: files,
          selectedFileId: "file-1",
          onFileSelect: mocks.select,
          error: null,
        },
      });
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    });

    it.each([false, true])(
      "preserves selection, scope reporting and refresh (navigateWithoutSelecting=%s)",
      async (navigateWithoutSelecting) => {
        const ref = createRef<SourceControlContentHandle>();
        const onGitFileSelect = vi.fn();
        const onGitFilesChange = vi.fn();
        const props = {
          ref,
          repoId: "repo-1",
          repoPath: "/workspace/repo",
          showFilter: true,
          viewMode: "list" as const,
          showOnlyStashes: true,
          sectionFilter: "staged" as const,
          navigateWithoutSelecting,
          onGitFileSelect,
          onGitFilesChange,
        };
        const renderPane = () =>
          host === "standalone"
            ? createElement(SourceControlTabContent, props)
            : createElement(SourceControlWithWorktrees, {
                ...props,
                worktrees: [],
                scope: { kind: "local" },
              });

        act(() => root.render(renderPane()));
        expect(mocks.state).toHaveBeenLastCalledWith({
          repoId: "repo-1",
          repoPath: "/workspace/repo",
          onGitFileSelect,
          autoLoadStashes: true,
        });
        expect(mocks.renderContent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            files,
            filteredFiles: files,
            showFilter: true,
            viewMode: "list",
            showOnlyStashes: true,
            sectionFilter: "staged",
            navigateWithoutSelecting,
          })
        );
        expect(onGitFilesChange).toHaveBeenCalledWith(files, "/workspace/repo");
        expect(container.textContent).toBe(
          navigateWithoutSelecting ? "unselected" : "file-1"
        );
        const button = container.querySelector("button");
        act(() => button?.click());
        if (navigateWithoutSelecting) {
          expect(onGitFileSelect).toHaveBeenCalledWith(files[0]);
          expect(mocks.select).not.toHaveBeenCalled();
        } else {
          expect(mocks.select).toHaveBeenCalledWith("file-1");
          expect(onGitFileSelect).not.toHaveBeenCalled();
        }
        act(() => root.render(renderPane()));
        expect(container.querySelector("button")).toBe(button);
        await act(async () => {
          await ref.current?.refresh();
        });
        expect(mocks.refresh).toHaveBeenCalledOnce();
      }
    );
  }
);
