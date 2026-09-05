// @vitest-environment jsdom
import { Provider } from "jotai";
import {
  type ComponentProps,
  act,
  createElement,
  useEffect,
  useState,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";

import { ChatPanelStartPage } from "./ChatPanelStartPage";

const mocks = vi.hoisted(() => ({
  mounts: vi.fn(),
  unmounts: vi.fn(),
  useAvailableAppUpdate: vi.fn(),
}));

vi.mock("@src/scaffold/AppUpdater", () => ({
  useAvailableAppUpdate: mocks.useAvailableAppUpdate,
}));
vi.mock("./StartPageQuotaModal", () => ({
  StartPageQuotaModal: ({
    onClose,
    visible,
  }: {
    onClose: () => void;
    visible: boolean;
  }) =>
    visible
      ? createElement(
          "button",
          { "data-testid": "quota-modal", onClick: onClose },
          "Quota modal"
        )
      : null,
}));

const t = ((key: string) => key) as ComponentProps<
  typeof ChatPanelStartPage
>["t"];

function TrackedAgentComposer({
  createTarget,
}: {
  createTarget: ChatPanelCreateTarget;
}) {
  useEffect(() => {
    mocks.mounts();
    return () => mocks.unmounts();
  }, []);

  return createElement("textarea", {
    "data-create-target": createTarget,
    "data-testid": "tracked-agent-composer",
    defaultValue: "draft",
  });
}

function Harness() {
  const [createTarget, setCreateTarget] = useState<ChatPanelCreateTarget>(
    CHAT_PANEL_CREATE_TARGET.AGENT_SESSION
  );

  return createElement(ChatPanelStartPage, {
    agentLauncher: ({ createTarget: agentCreateTarget, heroFooterSlot }) =>
      createElement(
        "div",
        null,
        createElement(TrackedAgentComposer, {
          createTarget: agentCreateTarget,
        }),
        heroFooterSlot
      ),
    createTarget,
    createTargetOptions: [
      { value: CHAT_PANEL_CREATE_TARGET.PROJECT, label: "Create project" },
    ],
    onAddApiKey: vi.fn(),
    onCreateTarget: (target) =>
      setCreateTarget(target as ChatPanelCreateTarget),
    onInstallLatestUpdate: vi.fn(),
    onProjectAgentModeChange: vi.fn(),
    onWorkItemAgentModeChange: vi.fn(),
    projectAgentMode: true,
    t,
    workItemAgentMode: true,
  });
}

describe("ChatPanelStartPage agent composer lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the agent composer mounted when Session changes to Work Item", () => {
    act(() => {
      root.render(createElement(Provider, null, createElement(Harness)));
    });

    const composer = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="tracked-agent-composer"]'
    );
    expect(composer).not.toBeNull();
    expect(mocks.mounts).toHaveBeenCalledTimes(1);
    composer!.value = "unfinished prompt";

    const workItemTab = container.querySelector<HTMLElement>(
      '[data-testid="chat-panel-start-page-tab-work-item"]'
    );
    expect(workItemTab).not.toBeNull();
    act(() => {
      workItemTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const workItemComposer = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="tracked-agent-composer"]'
    );
    expect(workItemComposer).toBe(composer);
    expect(workItemComposer?.value).toBe("unfinished prompt");
    expect(workItemComposer?.dataset.createTarget).toBe(
      CHAT_PANEL_CREATE_TARGET.WORK_ITEM
    );
    expect(mocks.mounts).toHaveBeenCalledTimes(1);
    expect(mocks.unmounts).not.toHaveBeenCalled();
  });

  it("opens and closes the quota modal from the quick action", () => {
    act(() => {
      root.render(createElement(Provider, null, createElement(Harness)));
    });

    const viewQuota = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-panel-start-page-show-quota"]'
    );
    expect(viewQuota).not.toBeNull();
    expect(container.querySelector('[data-testid="quota-modal"]')).toBeNull();

    act(() => {
      viewQuota?.click();
    });
    const quotaModal = container.querySelector<HTMLButtonElement>(
      '[data-testid="quota-modal"]'
    );
    expect(quotaModal).not.toBeNull();

    act(() => {
      quotaModal?.click();
    });
    expect(container.querySelector('[data-testid="quota-modal"]')).toBeNull();
  });
});
