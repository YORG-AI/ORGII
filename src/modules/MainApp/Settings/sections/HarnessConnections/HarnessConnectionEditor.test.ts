// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HarnessConnectionEditor from "./HarnessConnectionEditor";
import { refreshHarnessConnections } from "./useHarnessConnection";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  test: vi.fn(),
  apply: vi.fn(),
  cancelTest: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    agentOrgs: {
      connections: mocks,
      managedConfig: { restoreDefault: mocks.restore },
    },
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    loading: _loading,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    variant?: string;
  }) => createElement("button", props, children),
}));
vi.mock("@src/components/Select", () => ({
  default: ({
    options,
    value,
    onChange,
    placeholder,
    ...props
  }: {
    options: { value: string; label: string }[];
    value?: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) =>
    createElement(
      "select",
      {
        ...props,
        value: value ?? "",
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value),
      },
      createElement("option", { value: "" }, placeholder),
      ...options.map((option) =>
        createElement(
          "option",
          { key: option.value, value: option.value },
          option.label
        )
      )
    ),
}));
vi.mock("@src/modules/shared/layouts/SectionLayout", () => ({
  SectionContainer: ({ children }: { children: React.ReactNode }) =>
    createElement("section", null, children),
  SectionRow: ({
    children,
    label,
  }: {
    children: React.ReactNode;
    label: string;
  }) => createElement("div", null, label, children),
}));

let container: HTMLDivElement;
let root: Root;
function view(conflict = false) {
  return {
    installed: true,
    config: {
      agentName: "codex",
      mode: "direct",
      selectedKeyId: "gateway",
      selectedModel: "test-model",
      conflict,
      targetFiles: [],
    },
    choices: [
      {
        keyId: "gateway",
        name: "Work gateway",
        models: ["test-model", "other-model"],
        endpoint: "https://gateway.example/v1",
        requiresTest: true,
        reason: null,
      },
    ],
  };
}
function button(key: string) {
  const element = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === `harnessConnections.${key}`
  );
  if (!element) throw new Error(`Missing button ${key}`);
  return element;
}
async function mount() {
  await act(async () =>
    root.render(
      createElement(HarnessConnectionEditor, {
        agentName: "codex",
        onAdd: vi.fn(),
      })
    )
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.status.mockResolvedValue(view());
  mocks.test.mockResolvedValue("receipt-token");
  mocks.apply.mockResolvedValue(view().config);
  mocks.cancelTest.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("HarnessConnectionEditor", () => {
  it("requires a protocol test before applying a third-party connection and clears evidence on model change", async () => {
    await mount();
    expect(button("apply").disabled).toBe(true);
    await act(async () => button("test").click());
    expect(button("apply").disabled).toBe(false);
    await act(async () => button("apply").click());
    expect(mocks.apply).toHaveBeenCalledWith({
      agentName: "codex",
      keyId: "gateway",
      model: "test-model",
      routing: "direct",
      receipt: "receipt-token",
      expectedHashes: {},
    });
    const model = container.querySelector(
      'select[aria-label="harnessConnections.model"]'
    ) as HTMLSelectElement;
    await act(async () => {
      model.value = "other-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("apply").disabled).toBe(true);
  });

  it("preserves external configuration conflicts instead of offering destructive restore", async () => {
    mocks.status.mockResolvedValue(view(true));
    await mount();
    expect(button("apply").disabled).toBe(true);
    expect(button("restore").disabled).toBe(true);
    expect(container.textContent).toContain("harnessConnections.conflict");
  });

  it("cancels an in-flight test and discards its late result", async () => {
    let finish: (value: string) => void = () => undefined;
    mocks.test.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    await mount();
    await act(async () => button("test").click());
    await act(async () => button("cancel").click());
    expect(mocks.cancelTest).toHaveBeenCalledOnce();
    await act(async () => finish("late-token"));
    expect(button("apply").disabled).toBe(true);
    expect(container.textContent).not.toContain(
      "harnessConnections.testPassed"
    );
  });

  it("shares simultaneous reads and revalidates after an explicit change without polling", async () => {
    await act(async () =>
      root.render(
        createElement(
          React.Fragment,
          null,
          createElement(HarnessConnectionEditor, {
            agentName: "codex",
            onAdd: vi.fn(),
          }),
          createElement(HarnessConnectionEditor, {
            agentName: "codex",
            onAdd: vi.fn(),
          })
        )
      )
    );
    expect(mocks.status).toHaveBeenCalledTimes(1);
    await act(async () => refreshHarnessConnections());
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
});
