// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import {
  type RefObject,
  act,
  createElement,
  createRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  searchHasMoreAtom,
  searchLoadingMoreAtom,
} from "@src/store/workstation/codeEditor/search";

import { useSearchResults } from "../useSearchResults";

const listenerState = vi.hoisted(() => ({
  unlistens: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => {
    const unlisten = vi.fn();
    listenerState.unlistens.push(unlisten);
    return unlisten;
  }),
}));

const searchApi = vi.hoisted(() => ({
  searchCodeStreaming: vi.fn(),
}));

vi.mock("@src/api/tauri/search", () => ({
  searchCodeStreaming: searchApi.searchCodeStreaming,
}));

type Controller = ReturnType<typeof useSearchResults>;

const Probe = forwardRef<Controller>((_props, ref) => {
  const results = useSearchResults();
  useImperativeHandle(ref, () => results, [results]);
  return null;
});
Probe.displayName = "SearchResultsProbe";

const OPTIONS = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  fileExtensions: [],
  excludeDirs: [],
  filesToInclude: "",
  filesToExclude: "",
  onlyOpenFiles: false,
};

/**
 * Regression: the two per-request Tauri listeners registered by `loadMore`
 * were only unlistened on the success path. A rejected `searchCodeStreaming`
 * left both handlers — each closing over the whole current result set —
 * registered for the process lifetime.
 */
describe("useSearchResults.loadMore listener lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controllerRef: RefObject<Controller | null>;
  let store: ReturnType<typeof createStore>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    listenerState.unlistens.length = 0;
    searchApi.searchCodeStreaming.mockReset();
    store = createStore();
    store.set(searchHasMoreAtom, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    controllerRef = createRef<Controller>();
    act(() =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, { ref: controllerRef })
        )
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("releases both listeners when the streaming request rejects", async () => {
    searchApi.searchCodeStreaming.mockRejectedValueOnce(
      new Error("invalid regex")
    );
    await act(async () => {
      await controllerRef.current!.loadMore("foo(", "/repo", OPTIONS);
    });
    expect(listenerState.unlistens).toHaveLength(2);
    for (const unlisten of listenerState.unlistens) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
    expect(store.get(searchLoadingMoreAtom)).toBe(false);
  });
});
