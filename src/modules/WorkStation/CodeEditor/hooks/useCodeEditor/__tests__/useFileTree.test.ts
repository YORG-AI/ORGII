// @vitest-environment jsdom
import { type Atom, Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileNode } from "@src/store/workstation/codeEditor/file";
import { fileTreeAtom } from "@src/store/workstation/codeEditor/file";

import {
  COLLAPSED_SUBTREE_RETENTION_MS,
  MAX_RETAINED_TREE_NODES,
} from "../helpers";
import { useFileTree } from "../useFileTree";

vi.mock("@src/api/realtime/codeEditorWebSocket", () => ({
  getCodeEditorWebSocket: () => undefined,
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));
vi.mock("@src/store/workstation/codeEditor/file", async () => {
  const { atom } = await import("jotai");
  return {
    fileTreeAtom: atom<FileNode[]>([]),
    fileLoadingTreeAtom: atom(false),
    fileTreeErrorAtom: atom(null),
    fileSelectedPathAtom: atom(""),
  };
});

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let api: ReturnType<typeof useFileTree>;
let visible: boolean;
const leaf = (path: string): FileNode => ({ name: path, path, type: "file" });
function folder(path: string, children: FileNode[]): FileNode {
  return { name: path, path, type: "directory", expanded: true, children };
}
function Probe() {
  const current = useFileTree("/repo", false);
  useEffect(() => {
    api = current;
  });
  return null;
}
const tree = () => store.get(fileTreeAtom as Atom<FileNode[]>);
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function visibility(next: boolean) {
  await act(async () => {
    visible = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function mount(nodes: FileNode[]) {
  store.set(fileTreeAtom, nodes);
  await act(async () =>
    root.render(createElement(Provider, { store }, createElement(Probe)))
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  visible = true;
  store = createStore();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("file tree retention lifecycle", () => {
  it("owns no idle timer and expires a collapsed subtree once, preserving expansion", async () => {
    await mount([
      folder("/repo/a", [folder("/repo/a/b", [leaf("/repo/a/b/c")])]),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => api.toggleDirectory("/repo/a"));
    await advance(COLLAPSED_SUBTREE_RETENTION_MS - 1);
    expect(tree()[0].children).toHaveLength(1);
    await advance(1);
    expect(tree()[0].children).toBeUndefined();
    expect(tree()[0].retainedExpandedPaths).toEqual(["/repo/a/b"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses expiry while hidden and prunes on visibility return", async () => {
    await mount([folder("/repo/a", [leaf("/repo/a/b")])]);
    await act(async () => api.toggleDirectory("/repo/a"));
    await visibility(false);
    expect(vi.getTimerCount()).toBe(0);
    await advance(COLLAPSED_SUBTREE_RETENTION_MS * 2);
    expect(tree()[0].children).toHaveLength(1);
    await visibility(true);
    await advance(0);
    expect(tree()[0].children).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels expiry on re-expansion and cleans up on unmount", async () => {
    await mount([folder("/repo/a", [leaf("/repo/a/b")])]);
    await act(async () => api.toggleDirectory("/repo/a"));
    await advance(0);
    await act(async () => api.toggleDirectory("/repo/a"));
    expect(vi.getTimerCount()).toBe(0);
    await advance(COLLAPSED_SUBTREE_RETENTION_MS);
    expect(tree()[0].children).toHaveLength(1);
    await act(async () => api.toggleDirectory("/repo/a"));
    await advance(0);
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("prunes immediately above the node cap using the committed collapse", async () => {
    await mount([
      folder(
        "/repo/a",
        Array.from({ length: MAX_RETAINED_TREE_NODES }, (_, i) =>
          leaf(`/repo/a/${i}`)
        )
      ),
    ]);
    await act(async () => api.toggleDirectory("/repo/a"));
    await advance(0);
    expect(tree()[0].children).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps separate deadlines for multiple collapsed folders", async () => {
    await mount([
      folder("/repo/a", [leaf("/repo/a/x")]),
      folder("/repo/b", [leaf("/repo/b/x")]),
    ]);
    await act(async () => api.toggleDirectory("/repo/a"));
    await advance(30_000);
    await act(async () => api.toggleDirectory("/repo/b"));
    await advance(COLLAPSED_SUBTREE_RETENTION_MS - 30_000);
    expect(tree()[0].children).toBeUndefined();
    expect(tree()[1].children).toHaveLength(1);
    await advance(30_000);
    expect(tree()[1].children).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
