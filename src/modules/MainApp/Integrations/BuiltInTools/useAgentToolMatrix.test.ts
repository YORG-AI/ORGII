// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
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
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";

import {
  type UseAgentToolMatrixReturn,
  useAgentToolMatrix,
} from "./useAgentToolMatrix";

const mocks = vi.hoisted(() => ({
  updatePatch: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { agentDef: { updatePatch: mocks.updatePatch } },
}));

vi.mock("@src/modules/MainApp/AgentOrgs/hooks/useEnsureAgentDefs", () => ({
  useEnsureAgentDefs: () => true,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function Probe({
  onValue,
}: {
  onValue: (value: UseAgentToolMatrixReturn) => void;
}) {
  onValue(useAgentToolMatrix());
  return null;
}

describe("useAgentToolMatrix", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let latest: UseAgentToolMatrixReturn;

  const agent: AgentDefinition = {
    id: "builtin:sde",
    name: "SDE",
    builtIn: true,
    tools: {},
  };

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    store = createStore();
    store.set(builtInAgentsAtom, [agent]);
    store.set(customAgentsAtom, []);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Probe, { onValue: (value) => (latest = value) })
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("updates the shared atom optimistically and applies the saved definition", async () => {
    const saved = {
      ...agent,
      tools: { excludedTools: ["read_file"], userAllowedTools: [] },
    };
    mocks.updatePatch.mockResolvedValueOnce(saved);

    let request!: Promise<void>;
    act(() => {
      request = latest.toggle("builtin:sde", "read_file", false);
    });

    expect(latest.rowsByTool("read_file")[0]?.enabled).toBe(false);
    expect(store.get(builtInAgentsAtom)[0]?.tools?.excludedTools).toEqual([
      "read_file",
    ]);

    await act(async () => request);
    expect(store.get(builtInAgentsAtom)[0]).toEqual(saved);
  });

  it("rolls back the shared atom when persistence fails", async () => {
    mocks.updatePatch.mockRejectedValueOnce(new Error("write failed"));

    await act(async () => {
      await latest.toggle("builtin:sde", "read_file", false);
    });

    expect(latest.rowsByTool("read_file")[0]?.enabled).toBe(true);
    expect(store.get(builtInAgentsAtom)[0]).toEqual(agent);
  });
});
