import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import { fileSelectedPathAtom } from "@src/store/workstation/codeEditor/file";
import type { WorkspaceFolder } from "@src/types/workspace";

import { workspaceFoldersAtom as workspaceFoldersAtomFromLegacyBarrel } from "../../ui/workspace";
import {
  activeFolderIdAtom,
  workspaceFoldersAtom,
} from "../../ui/workspaceFoldersAtom";
import {
  activeFolderAtom,
  activeWorkspaceRootNameAtom,
  activeWorkspaceRootPathAtom,
  primaryFolderAtom,
} from "../derived";

const folders: WorkspaceFolder[] = [
  {
    id: "primary",
    name: "Primary Repo",
    path: "/tmp/orgii-primary",
    uri: "file:///tmp/orgii-primary",
    isPrimary: true,
    repoId: "primary-repo-id",
  },
  {
    id: "secondary",
    name: "Secondary Repo",
    path: "/tmp/orgii-secondary",
    uri: "file:///tmp/orgii-secondary",
    isPrimary: false,
    repoId: "secondary-repo-id",
  },
  {
    id: "nested",
    name: "Nested Repo",
    path: "/tmp/orgii-secondary/packages/nested",
    uri: "file:///tmp/orgii-secondary/packages/nested",
    isPrimary: false,
    repoId: "nested-repo-id",
  },
];

describe("workspace derived atoms", () => {
  it("keeps legacy workspace barrel wired to the canonical folder atom", () => {
    expect(workspaceFoldersAtomFromLegacyBarrel).toBe(workspaceFoldersAtom);
  });

  it("keeps primary folder stable when active folder is overridden", () => {
    const store = createStore();
    store.set(workspaceFoldersAtom, folders);

    expect(store.get(primaryFolderAtom)?.id).toBe("primary");
    expect(store.get(activeFolderAtom)?.id).toBe("primary");

    store.set(activeFolderIdAtom, "secondary");

    expect(store.get(primaryFolderAtom)?.id).toBe("primary");
    expect(store.get(activeFolderAtom)?.id).toBe("secondary");
  });

  it("resolves workspace name and path from the folder model alone", () => {
    // The status bar reads both of these directly, so they must resolve with
    // no WorkStation content host mounted to push them in.
    const store = createStore();
    expect(store.get(activeWorkspaceRootNameAtom)).toBe("");
    expect(store.get(activeWorkspaceRootPathAtom)).toBe("");

    store.set(workspaceFoldersAtom, folders);

    expect(store.get(activeWorkspaceRootNameAtom)).toBe("Primary Repo");
    expect(store.get(activeWorkspaceRootPathAtom)).toBe("/tmp/orgii-primary");

    store.set(activeFolderIdAtom, "secondary");

    expect(store.get(activeWorkspaceRootNameAtom)).toBe("Secondary Repo");
    expect(store.get(activeWorkspaceRootPathAtom)).toBe("/tmp/orgii-secondary");
  });

  it("uses the most specific editor-owning folder only as active focus", () => {
    const store = createStore();
    store.set(workspaceFoldersAtom, folders);
    store.set(
      fileSelectedPathAtom,
      "/tmp/orgii-secondary/packages/nested/src/index.ts"
    );

    expect(store.get(activeFolderAtom)?.id).toBe("nested");
    expect(store.get(primaryFolderAtom)?.id).toBe("primary");
  });
});
