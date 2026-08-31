import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Provider, createStore } from "jotai";
import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitApi } from "@src/api/http/git";
import { repoApi } from "@src/api/tauri/repo";
import {
  REPO_KIND,
  type Repo,
  reposAtom,
  validRepoIdsAtom,
} from "@src/store/repo";
import { sessionSourceAtom } from "@src/store/session/creatorStateAtom";
import { showNativeMessageSafely } from "@src/util/dialogs/nativeDialog";
import { popupNativeMenu } from "@src/util/platform/tauri/nativeMenuPopup";

import { NO_WORKSPACE_KEY } from "../types";
import type { WorkspaceGroupActions } from "../useSessionMenuItems/types";
import { useWorkspaceGroupActions } from "./useWorkspaceGroupActions";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/util/dialogs/nativeDialog", () => ({
  showNativeMessageSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/api/tauri/repo", () => ({
  repoApi: {
    validateWorkspacePath: vi.fn(),
    getRepos: vi.fn(),
    checkIsGitRepo: vi.fn(),
    importLocalRepo: vi.fn(),
    importWorkFolder: vi.fn(),
  },
}));

vi.mock("@src/api/http/git", () => ({
  gitApi: {
    getGitCurrentBranchName: vi.fn(),
  },
}));

vi.mock("@src/util/platform/tauri/nativeMenuPopup", () => ({
  popupNativeMenu: vi.fn().mockResolvedValue({ status: "closed" }),
}));

const mockedPopupNativeMenu = vi.mocked(popupNativeMenu);
const mockedRevealItemInDir = vi.mocked(revealItemInDir);
const mockedValidateWorkspacePath = vi.mocked(repoApi.validateWorkspacePath);
const mockedGetRepos = vi.mocked(repoApi.getRepos);
const mockedCheckIsGitRepo = vi.mocked(repoApi.checkIsGitRepo);
const mockedImportLocalRepo = vi.mocked(repoApi.importLocalRepo);
const mockedImportWorkFolder = vi.mocked(repoApi.importWorkFolder);
const mockedGetGitCurrentBranchName = vi.mocked(gitApi.getGitCurrentBranchName);
const mockedShowNativeMessageSafely = vi.mocked(showNativeMessageSafely);

const EXTERNAL_WORKSPACE = "/external/orgii-cloud-infra";

function repoImportResponse(
  overrides: {
    id?: string;
    name?: string;
    path?: string;
    kind?: "git" | "folder";
  } = {}
) {
  return {
    data: {
      repo_id: overrides.id ?? EXTERNAL_WORKSPACE,
      user_id: "",
      name: overrides.name ?? "orgii-cloud-infra",
      path: overrides.path ?? EXTERNAL_WORKSPACE,
      kind: overrides.kind ?? ("git" as const),
    },
    status: 0,
  };
}

interface RenderedWorkspaceGroupActions {
  actions: WorkspaceGroupActions;
  store: ReturnType<typeof createStore>;
  openNewSession: ReturnType<typeof vi.fn>;
}

function renderWorkspaceGroupActions(
  seededRepos: Repo[] = []
): RenderedWorkspaceGroupActions {
  const store = createStore();
  store.set(reposAtom, seededRepos);
  const openNewSession = vi.fn();
  let actions: WorkspaceGroupActions | undefined;

  function HookProbe(): null {
    // eslint-disable-next-line react-hooks/globals -- server-rendered test probe synchronously exports the hook result; the component never mounts or re-renders
    actions = useWorkspaceGroupActions({
      createSessionLabel: "New session",
      moreActionsLabel: "More actions",
      pinLabel: "Pin workspace",
      unpinLabel: "Unpin workspace",
      hideLabel: "Hide workspace",
      unhideLabel: "Unhide workspace",
      revealLabel: "Reveal in file manager",
      unavailableTitle: "Workspace no longer available",
      unavailableMessage: "This Workspace may have been moved or deleted.",
      openNewSession,
      setCollapsedSectionIds: vi.fn(),
    });
    return null;
  }

  renderToString(
    React.createElement(Provider, { store }, React.createElement(HookProbe))
  );

  if (!actions) throw new Error("workspace group actions did not render");
  return { actions, store, openNewSession };
}

describe("useWorkspaceGroupActions", () => {
  beforeEach(() => {
    mockedPopupNativeMenu.mockClear();
    mockedRevealItemInDir.mockClear();
    mockedValidateWorkspacePath.mockReset();
    mockedValidateWorkspacePath.mockImplementation(async (path) => path);
    mockedShowNativeMessageSafely.mockClear();
    mockedGetRepos.mockReset();
    mockedGetRepos.mockResolvedValue({ data: { repos: [] }, status: 0 });
    mockedCheckIsGitRepo.mockReset();
    mockedCheckIsGitRepo.mockResolvedValue(true);
    mockedImportLocalRepo.mockReset();
    mockedImportLocalRepo.mockResolvedValue(repoImportResponse());
    mockedImportWorkFolder.mockReset();
    mockedImportWorkFolder.mockResolvedValue(
      repoImportResponse({ kind: "folder" })
    );
    mockedGetGitCurrentBranchName.mockReset();
    mockedGetGitCurrentBranchName.mockResolvedValue("develop");
  });

  it("reveals actual workspace groups in the OS file manager", async () => {
    const { actions } = renderWorkspaceGroupActions();
    actions.onOpenMenu("/workspace/orgii");

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    expect(
      items?.map((item) => ("text" in item ? item.text : item.item))
    ).toEqual([
      "Reveal in file manager",
      "Separator",
      "Pin workspace",
      "Hide workspace",
    ]);

    const revealItem = items?.[0];
    if (revealItem && "action" in revealItem) {
      revealItem.action?.("reveal-workspace");
    }
    await vi.waitFor(() => {
      expect(mockedRevealItemInDir).toHaveBeenCalledWith("/workspace/orgii");
    });
    expect(mockedShowNativeMessageSafely).not.toHaveBeenCalled();
  });

  it("shows a native warning when the workspace folder no longer exists", async () => {
    mockedValidateWorkspacePath.mockRejectedValue(
      new Error("Unable to access workspace path")
    );
    const { actions } = renderWorkspaceGroupActions();
    actions.onOpenMenu("/workspace/missing");

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    const revealItem = items?.[0];
    if (revealItem && "action" in revealItem) {
      revealItem.action?.("reveal-workspace");
    }

    await vi.waitFor(() => {
      expect(mockedShowNativeMessageSafely).toHaveBeenCalledWith(
        "This Workspace may have been moved or deleted.\n\n/workspace/missing",
        {
          title: "Workspace no longer available",
          kind: "warning",
        }
      );
    });
    expect(mockedRevealItemInDir).not.toHaveBeenCalled();
  });

  it("omits reveal for the synthetic no-workspace group", async () => {
    const { actions } = renderWorkspaceGroupActions();
    actions.onOpenMenu(NO_WORKSPACE_KEY);

    const popupOptions = mockedPopupNativeMenu.mock.calls[0]?.[0];
    const items = await popupOptions?.buildItems();
    expect(
      items?.map((item) => ("text" in item ? item.text : item.item))
    ).toEqual(["Pin workspace", "Hide workspace"]);
    expect(mockedRevealItemInDir).not.toHaveBeenCalled();
  });

  it("adds an unregistered workspace group before sourcing the session there", async () => {
    const { actions, store, openNewSession } = renderWorkspaceGroupActions();

    actions.onCreateSession(EXTERNAL_WORKSPACE);

    // The composer opens immediately on the clicked workspace; the repo id is
    // still unknown at this point.
    expect(openNewSession).toHaveBeenCalledTimes(1);
    expect(store.get(sessionSourceAtom)).toMatchObject({
      type: "local",
      repoId: undefined,
      repoName: "orgii-cloud-infra",
      repoPath: EXTERNAL_WORKSPACE,
    });

    await vi.waitFor(() => {
      expect(store.get(sessionSourceAtom)).toMatchObject({
        repoId: EXTERNAL_WORKSPACE,
        repoName: "orgii-cloud-infra",
        repoPath: EXTERNAL_WORKSPACE,
        branch: "develop",
      });
    });
    expect(mockedImportLocalRepo).toHaveBeenCalledWith({
      fs_path: EXTERNAL_WORKSPACE,
    });
    expect(store.get(reposAtom)).toEqual([
      {
        id: EXTERNAL_WORKSPACE,
        name: "orgii-cloud-infra",
        path: EXTERNAL_WORKSPACE,
        fs_uri: EXTERNAL_WORKSPACE,
        kind: REPO_KIND.GIT,
      },
    ]);
    // Branch loading is gated on this set, so the added repo has to land in it.
    expect(store.get(validRepoIdsAtom).has(EXTERNAL_WORKSPACE)).toBe(true);
  });

  it("registers a directory without git as a work folder rather than initializing one", async () => {
    mockedCheckIsGitRepo.mockResolvedValue(false);
    const { actions, store } = renderWorkspaceGroupActions();

    actions.onCreateSession(EXTERNAL_WORKSPACE);

    await vi.waitFor(() => {
      expect(store.get(sessionSourceAtom)?.repoId).toBe(EXTERNAL_WORKSPACE);
    });
    expect(mockedImportWorkFolder).toHaveBeenCalledWith({
      fs_path: EXTERNAL_WORKSPACE,
    });
    expect(mockedImportLocalRepo).not.toHaveBeenCalled();
    // A work folder has no branch to read.
    expect(mockedGetGitCurrentBranchName).not.toHaveBeenCalled();
    expect(store.get(sessionSourceAtom)?.branch).toBeUndefined();
  });

  it("reuses a registration the repo list has not loaded yet instead of re-importing", async () => {
    // `reposAtom` is empty until the startup load lands; re-importing in that
    // window would upsert `kind` and quietly turn a work folder into a git repo.
    mockedGetRepos.mockResolvedValue({
      data: {
        repos: [
          {
            repo_id: EXTERNAL_WORKSPACE,
            user_id: "",
            name: "orgii-cloud-infra",
            path: EXTERNAL_WORKSPACE,
            kind: "folder" as const,
          },
        ],
      },
      status: 0,
    });
    const { actions, store } = renderWorkspaceGroupActions();

    actions.onCreateSession(EXTERNAL_WORKSPACE);

    await vi.waitFor(() => {
      expect(store.get(sessionSourceAtom)?.repoId).toBe(EXTERNAL_WORKSPACE);
    });
    expect(mockedImportLocalRepo).not.toHaveBeenCalled();
    expect(mockedImportWorkFolder).not.toHaveBeenCalled();
    expect(store.get(reposAtom)).toEqual([
      {
        id: EXTERNAL_WORKSPACE,
        name: "orgii-cloud-infra",
        path: EXTERNAL_WORKSPACE,
        fs_uri: EXTERNAL_WORKSPACE,
        kind: REPO_KIND.FOLDER,
      },
    ]);
    expect(mockedGetGitCurrentBranchName).not.toHaveBeenCalled();
  });

  it("resolves the branch for a group that is already a workspace without importing again", async () => {
    const { actions, store } = renderWorkspaceGroupActions([
      {
        id: "repo-1",
        name: "orgii-cloud-infra",
        path: EXTERNAL_WORKSPACE,
        kind: REPO_KIND.GIT,
      },
    ]);

    actions.onCreateSession(EXTERNAL_WORKSPACE);

    await vi.waitFor(() => {
      expect(store.get(sessionSourceAtom)?.branch).toBe("develop");
    });
    expect(store.get(sessionSourceAtom)).toMatchObject({ repoId: "repo-1" });
    expect(mockedGetRepos).not.toHaveBeenCalled();
    expect(mockedCheckIsGitRepo).not.toHaveBeenCalled();
    expect(mockedImportLocalRepo).not.toHaveBeenCalled();
  });

  it("keeps the session sourced at the path when the directory can no longer be added", async () => {
    mockedImportLocalRepo.mockRejectedValue(
      new Error("Path does not exist: /external/orgii-cloud-infra")
    );
    const { actions, store, openNewSession } = renderWorkspaceGroupActions();

    actions.onCreateSession(EXTERNAL_WORKSPACE);

    await vi.waitFor(() => {
      expect(mockedImportLocalRepo).toHaveBeenCalled();
    });
    // The session still launches at the clicked path — a workspace that can no
    // longer be registered is not a reason to swallow the click.
    expect(openNewSession).toHaveBeenCalledTimes(1);
    expect(store.get(sessionSourceAtom)).toMatchObject({
      repoId: undefined,
      repoPath: EXTERNAL_WORKSPACE,
    });
    expect(store.get(reposAtom)).toEqual([]);
  });

  it("leaves the source alone when the composer moved on while the import was in flight", async () => {
    let resolveImport: (() => void) | undefined;
    mockedImportLocalRepo.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = () => resolve(repoImportResponse());
        })
    );
    const { actions, store } = renderWorkspaceGroupActions();

    actions.onCreateSession(EXTERNAL_WORKSPACE);
    await vi.waitFor(() => {
      expect(resolveImport).toBeDefined();
    });

    // The viewer picked a different workspace before the import landed.
    store.set(sessionSourceAtom, {
      type: "local",
      repoId: "repo-2",
      repoName: "other",
      repoPath: "/workspace/other",
    });
    resolveImport?.();

    await vi.waitFor(() => {
      expect(store.get(reposAtom)).toHaveLength(1);
    });
    expect(store.get(sessionSourceAtom)).toMatchObject({
      repoId: "repo-2",
      repoPath: "/workspace/other",
    });
  });

  it("does not start a session for the synthetic no-workspace group", () => {
    const { actions, store, openNewSession } = renderWorkspaceGroupActions();

    actions.onCreateSession(NO_WORKSPACE_KEY);

    expect(openNewSession).not.toHaveBeenCalled();
    expect(store.get(sessionSourceAtom)).toBeNull();
    expect(mockedCheckIsGitRepo).not.toHaveBeenCalled();
  });
});
