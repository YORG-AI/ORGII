// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";

import ModelPill from "./ModelPill";

const fixture = vi.hoisted(() => ({
  sessionId: "session-1",
  binding: {
    root: {
      authority: "local-session",
      authorityScope: [],
      conversationId: "session-1",
    },
    cloudTarget: null,
    selection: {
      keySource: "own",
      cliAgentType: "codex",
      model: "gpt-5.5",
      selectedAccountId: "openai-1",
    },
    runtimeSelection: {
      category: "cli_agent",
      targetKind: "cli_agent",
      cliAgentType: "codex",
      agentName: "Codex",
    },
    target: {
      cliAgentType: "codex",
      accountId: "openai-1",
      model: "gpt-5.5",
      workspaceRepoPath: "/tmp/repo",
    },
    readiness: "ready",
    nativeCliTargets: ["codex", "claude_code"],
    applyRuntimePick: vi.fn(() => true),
    applyModelPick: vi.fn(() => true),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/engines/ChatPanel/ConversationExecutionBindingContext", () => ({
  useConversationExecutionBinding: () => fixture.binding,
}));
vi.mock("@src/engines/SessionCore/hooks/session", () => ({
  useSessionId: () => ({ sessionId: fixture.sessionId }),
}));
vi.mock("@src/hooks/models/useValidatedLastPair", () => ({
  useValidatedLastPair: () => null,
}));
vi.mock("@src/hooks/session/useSessionPatch", () => ({
  useSessionModelField: () => ({ setModel: vi.fn() }),
}));
vi.mock("@src/store/session", async () => {
  const { atom } = await import("jotai");
  const emptySessionAtom = atom(undefined);
  return { sessionByIdAtom: () => emptySessionAtom };
});
vi.mock("@src/store/session/cliSessionStatusAtom", async () => {
  const { atom } = await import("jotai");
  return { sessionRuntimeStatusAtom: atom("idle") };
});
vi.mock("@src/store/ui/chatPanelAtom", async () => {
  const { atom } = await import("jotai");
  return { modelPickerStyleAtom: atom("spotlight") };
});
vi.mock("@src/components/AnyIcon", () => ({ default: () => null }));
vi.mock("@src/components/ModelIcon", () => ({ default: () => null }));
vi.mock("@src/components/Message", () => ({
  Message: { info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@src/components/SelectorPill", async () => {
  const { createElement, forwardRef } = await import("react");
  return {
    default: forwardRef<
      HTMLButtonElement,
      { onClick: () => void; dataTestId: string }
    >(({ onClick, dataTestId }, ref) =>
      createElement("button", {
        ref,
        "data-testid": dataTestId,
        onClick,
      })
    ),
  };
});
vi.mock("@src/components/ModelSelectorPill", async () => {
  const { createElement, forwardRef } = await import("react");
  return {
    default: forwardRef<
      HTMLButtonElement,
      { onClick: () => void; dataTestId: string }
    >(({ onClick, dataTestId }, ref) =>
      createElement("button", {
        ref,
        "data-testid": dataTestId,
        onClick,
      })
    ),
  };
});
vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette/DispatchCategoryPicker",
  async () => {
    const React = await import("react");
    return {
      DispatchCategoryPicker: ({
        isOpen,
        onSelect,
      }: {
        isOpen: boolean;
        onSelect: (selection: Record<string, unknown>) => void;
      }) =>
        isOpen
          ? React.createElement(
              "div",
              { "data-testid": "runtime-palette" },
              React.createElement("button", {
                "data-testid": "runtime-choice-claude",
                onClick: () =>
                  onSelect({
                    category: "cli_agent",
                    targetKind: "cli_agent",
                    cliAgentType: "claude_code",
                    agentName: "Claude Code",
                  }),
              })
            )
          : null,
    };
  }
);
vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette",
  async () => {
    const React = await import("react");
    return {
      UnifiedModelPalette: ({
        isOpen,
        cliAgentTypeOverride,
      }: {
        isOpen: boolean;
        cliAgentTypeOverride?: string;
      }) =>
        isOpen
          ? React.createElement("div", {
              "data-testid": "model-palette",
              "data-cli-agent-type": cliAgentTypeOverride,
            })
          : null,
    };
  }
);
vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/UnifiedModelDropdown",
  async () => {
    const React = await import("react");
    return {
      UnifiedModelDropdown: ({ isOpen }: { isOpen: boolean }) =>
        isOpen
          ? React.createElement("div", { "data-testid": "model-dropdown" })
          : null,
    };
  }
);

describe("ModelPill disclosure ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  function showBoundCodex(): void {
    Object.assign(fixture.binding.selection, {
      cliAgentType: "codex",
      model: "gpt-5.5",
      selectedAccountId: "openai-1",
    });
    Object.assign(fixture.binding.runtimeSelection, {
      cliAgentType: "codex",
      agentName: "Codex",
    });
    Object.assign(fixture.binding.target, {
      cliAgentType: "codex",
      accountId: "openai-1",
      model: "gpt-5.5",
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fixture.sessionId = "session-1";
    showBoundCodex();
    fixture.binding.applyRuntimePick.mockReset();
    fixture.binding.applyRuntimePick.mockReturnValue(true);
    store = createStore();
    store.set(modelSelectorAtom, { isOpen: false });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        React.createElement(Provider, { store }, React.createElement(ModelPill))
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  function click(testId: string): void {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`
    );
    if (!button) throw new Error(`missing ${testId}`);
    act(() => button.click());
  }

  function renderCurrentSession(): void {
    root.render(
      React.createElement(Provider, { store }, React.createElement(ModelPill))
    );
  }

  function showBoundAmbientClaude(): void {
    Object.assign(fixture.binding.selection, {
      cliAgentType: "claude_code",
      model: "default",
      selectedAccountId: undefined,
    });
    Object.assign(fixture.binding.runtimeSelection, {
      cliAgentType: "claude_code",
      agentName: "Claude Code",
    });
    Object.assign(fixture.binding.target, {
      cliAgentType: "claude_code",
      accountId: undefined,
      model: undefined,
    });
  }

  it("keeps the runtime and model palettes mutually exclusive", () => {
    click("chat-runtime-pill");
    expect(
      container.querySelector('[data-testid="runtime-palette"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="model-palette"]')).toBeNull();

    click("chat-model-pill-model");
    expect(
      container.querySelector('[data-testid="runtime-palette"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="model-palette"]')
    ).not.toBeNull();

    click("chat-runtime-pill");
    expect(container.querySelector('[data-testid="model-palette"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="runtime-palette"]')
    ).not.toBeNull();
  });

  it("discards an unfinished runtime pick when the conversation changes", () => {
    fixture.binding.applyRuntimePick.mockReturnValue(false);
    click("chat-runtime-pill");
    click("runtime-choice-claude");
    expect(
      container
        .querySelector('[data-testid="model-palette"]')
        ?.getAttribute("data-cli-agent-type")
    ).toBe("claude_code");

    act(() => {
      fixture.sessionId = "session-2";
      store.set(modelSelectorAtom, { isOpen: true });
      renderCurrentSession();
    });
    expect(
      container
        .querySelector('[data-testid="model-palette"]')
        ?.getAttribute("data-cli-agent-type")
    ).toBe("codex");

    act(() => {
      fixture.sessionId = "session-1";
      store.set(modelSelectorAtom, { isOpen: true });
      renderCurrentSession();
    });
    expect(
      container
        .querySelector('[data-testid="model-palette"]')
        ?.getAttribute("data-cli-agent-type")
    ).toBe("codex");
  });

  it("stops masking an ambient Claude target after the binding resolves", () => {
    fixture.binding.applyRuntimePick.mockReturnValue(false);
    click("chat-runtime-pill");
    click("runtime-choice-claude");
    expect(
      container
        .querySelector('[data-testid="chat-model-target"]')
        ?.getAttribute("data-model-id")
    ).toBeNull();

    act(() => {
      showBoundAmbientClaude();
      store.set(modelSelectorAtom, { isOpen: false });
      renderCurrentSession();
    });

    expect(
      container
        .querySelector('[data-testid="chat-model-target"]')
        ?.getAttribute("data-model-id")
    ).toBe("default");
  });
});
