// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
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

import Select from "@src/components/Select";
import { isAgentOrgOverviewInteractionTarget } from "@src/engines/ChatPanel/ChatHistory/hooks/useChatNavigationController";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function ReassignHarness({
  onConfirm,
}: {
  onConfirm: (memberId: string) => void;
}) {
  const [overviewOpen, setOverviewOpen] = useState(true);
  const [replacementOwner, setReplacementOwner] = useState("");

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (isAgentOrgOverviewInteractionTarget(event.target)) return;
      setOverviewOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  if (!overviewOpen) {
    return createElement("div", { "data-testid": "reassign-overview-closed" });
  }

  return createElement(
    "div",
    {
      "data-agent-org-overview-panel": true,
      "data-testid": "reassign-overview",
    },
    createElement(Select, {
      value: replacementOwner,
      onChange: (value) => setReplacementOwner(String(value)),
      options: [
        { label: "Planner", value: "sde-planner" },
        {
          label: "Tester",
          value: "sde-tester",
          dataTestId: "reassign-option-tester",
        },
      ],
      defaultPopupVisible: true,
      panelClassName: "agent-org-overview-owned-overlay",
      ariaLabel: "Replacement owner",
    }),
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "reassign-confirm",
        disabled: !replacementOwner,
        onClick: () => onConfirm(replacementOwner),
      },
      "Reassign"
    )
  );
}

describe("Agent Org Reassign portalled Select", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps Overview open while selecting and waits for explicit confirmation", async () => {
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(createElement(ReassignHarness, { onConfirm }));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    const testerOption = document.body.querySelector<HTMLElement>(
      '[data-testid="reassign-option-tester"]'
    );
    expect(testerOption).not.toBeNull();

    await act(async () => {
      testerOption?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      testerOption?.click();
    });

    expect(
      container.querySelector('[data-testid="reassign-overview"]')
    ).not.toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="reassign-confirm"]')
        ?.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("sde-tester");
  });
});
