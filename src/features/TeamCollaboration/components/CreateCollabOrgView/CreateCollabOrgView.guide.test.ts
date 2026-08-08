// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act, forwardRef } from "react";
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

import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import {
  CHAT_PANEL_COLLAB_ORG_MODE,
  CHAT_PANEL_COLLAB_ORG_SOURCE,
  chatPanelCollabOrgCreateIntentAtom,
} from "@src/store/ui/chatPanelAtom";
import { guideHighlightAtom } from "@src/store/ui/guideHighlightAtom";

import CreateCollabOrgView from "./index";

const mocks = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  joinOrganization: vi.fn(),
  openCloudSignIn: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/features/Org2Cloud/useCloudOrgMembershipActions", () => ({
  CloudOrgMembershipActionFailure: class extends Error {},
  useCloudOrgMembershipActions: () => ({
    createOrganization: mocks.createOrganization,
    joinOrganization: mocks.joinOrganization,
  }),
}));

vi.mock("@src/features/Org2Cloud/useOrg2CloudSignIn", () => ({
  useOrg2CloudSignIn: () => mocks.openCloudSignIn,
}));

vi.mock("@src/components/Input", () => ({
  default: forwardRef<
    HTMLInputElement,
    Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
      onChange?: (
        value: string,
        event: React.ChangeEvent<HTMLInputElement>
      ) => void;
    }
  >(function MockInput({ onChange, ...props }, ref) {
    return React.createElement("input", {
      ...props,
      ref,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChange?.(event.target.value, event),
    });
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    loading: _loading,
    icon: _icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    icon?: React.ReactNode;
  }) => React.createElement("button", props, children),
}));

vi.mock("@src/scaffold/WizardSystem/primitives/SelectionGrid", () => ({
  default: ({
    options,
    selected,
    onSelect,
  }: {
    options: Array<{ key: string; label: string; dataTestId?: string }>;
    selected: string | null;
    onSelect: (key: string) => void;
  }) =>
    React.createElement(
      "div",
      null,
      options.map((option) =>
        React.createElement(
          "button",
          {
            key: option.key,
            "data-testid": option.dataTestId,
            "aria-pressed": selected === option.key,
            onClick: () => onSelect(option.key),
          },
          option.label
        )
      )
    ),
}));

vi.mock("@src/modules/shared/layouts/SectionLayout", () => ({
  SECTION_ACTION_GAP_CLASSES: "",
  SectionContainer: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  SectionRow: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CreateCollabOrgView guide navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const onCancel = vi.fn();

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("consumes the guide preset, selects cloud creation, and focuses the name", async () => {
    store.set(chatPanelCollabOrgCreateIntentAtom, {
      requestId: 11,
      source: CHAT_PANEL_COLLAB_ORG_SOURCE.CLOUD,
      mode: CHAT_PANEL_COLLAB_ORG_MODE.CREATE,
    });
    store.set(guideHighlightAtom, {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      message: "Create an organization",
      createdAt: 11,
    });

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CreateCollabOrgView, { onCancel })
        )
      );
    });

    expect(
      container
        .querySelector('[data-testid="create-collab-org-source-cloud"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      container
        .querySelector('[data-testid="create-collab-org-mode-create"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");

    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="create-collab-org-name"]'
    );
    const guideTarget = container.querySelector<HTMLElement>(
      `[data-guide-target="${GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT}"]`
    );
    expect(guideTarget?.dataset.guideTarget).toBe(
      GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT
    );
    expect(guideTarget).toBe(nameInput?.parentElement);
    expect(guideTarget?.tagName).toBe("DIV");
    expect(document.activeElement).toBe(nameInput);
    expect(store.get(chatPanelCollabOrgCreateIntentAtom)).toBeNull();
    expect(store.get(guideHighlightAtom)?.targetId).toBe(
      GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT
    );
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="create-collab-org-submit"]'
      )?.disabled
    ).toBe(true);
  });

  it("keeps ordinary Add ORG navigation unselected", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CreateCollabOrgView, { onCancel })
        )
      );
    });

    expect(
      container.querySelector('[data-testid="create-collab-org-name"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="create-collab-org-source-cloud"]')
        ?.getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("clears only its own spotlight when the guided form is cancelled", async () => {
    store.set(chatPanelCollabOrgCreateIntentAtom, {
      requestId: 12,
      source: CHAT_PANEL_COLLAB_ORG_SOURCE.CLOUD,
      mode: CHAT_PANEL_COLLAB_ORG_MODE.CREATE,
    });
    store.set(guideHighlightAtom, {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      message: "Create an organization",
      createdAt: 12,
    });

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CreateCollabOrgView, { onCancel })
        )
      );
    });

    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "common:actions.cancel"
    );
    act(() => cancel?.click());

    expect(onCancel).toHaveBeenCalledOnce();
    expect(store.get(guideHighlightAtom)).toBeNull();
  });
});
