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

import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { guideHighlightAtom } from "@src/store/ui/guideHighlightAtom";

import CollabOrgForm from "./CollabOrgForm";

const mocks = vi.hoisted(() => ({
  createLocalOrg: vi.fn(),
  createOrganization: vi.fn(),
  joinOrganization: vi.fn(),
  openCloudSignIn: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: { createOrg: mocks.createLocalOrg },
}));

vi.mock("@src/components/Message", () => ({
  default: { success: vi.fn(), error: vi.fn() },
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
      onChange?: (value: string) => void;
    }
  >(function MockInput({ onChange, ...props }, ref) {
    return React.createElement("input", {
      ...props,
      ref,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChange?.(event.target.value),
    });
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    loading: _loading,
    icon: _icon,
    iconPosition: _iconPosition,
    iconOnly: _iconOnly,
    appearance: _appearance,
    htmlType,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    icon?: React.ReactNode;
    iconPosition?: string;
    iconOnly?: boolean;
    appearance?: string;
    htmlType?: "button" | "submit";
  }) => React.createElement("button", { ...props, type: htmlType }, children),
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
            type: "button",
            "data-testid": option.dataTestId,
            "aria-pressed": selected === option.key,
            onClick: () => onSelect(option.key),
          },
          option.label
        )
      )
    ),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CollabOrgForm", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const onCancel = vi.fn();
  const onCompleted = vi.fn();

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    localStorage.clear();
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

  async function renderForm(
    props: Partial<React.ComponentProps<typeof CollabOrgForm>> = {}
  ) {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CollabOrgForm, {
            onCancel,
            onCompleted,
            ...props,
          })
        )
      );
    });
  }

  async function enterValue(testId: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(
      `[data-testid="${testId}"]`
    );
    await act(async () => {
      if (!input) return;
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setValue?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submitForm() {
    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="collab-org-form"]'
    );
    await act(async () => {
      form?.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true })
      );
    });
  }

  function signIn() {
    store.set(org2CloudAuthAtom, {
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.com",
      supabaseAnonKey: "anon",
      userId: "user-1",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 4_000_000_000,
    });
  }

  it("opens a cloud create preset and focuses the organization name", async () => {
    store.set(guideHighlightAtom, {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      message: "Create an organization",
      createdAt: 11,
    });

    await renderForm({ initialSource: "cloud", initialMode: "create" });

    expect(container.textContent).toContain(
      "common:selectors.spotlight.actions.createOrganization.label"
    );
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
    expect(document.activeElement).toBe(nameInput);
    expect(
      container.querySelector(
        `[data-guide-target="${GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT}"]`
      )
    ).toBe(nameInput?.parentElement);
  });

  it("opens a cloud join preset with the invite field", async () => {
    await renderForm({ initialSource: "cloud", initialMode: "join" });

    expect(container.textContent).toContain(
      "common:selectors.spotlight.actions.joinOrganization.label"
    );
    expect(
      container
        .querySelector('[data-testid="create-collab-org-mode-join"]')
        ?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="create-collab-org-invite"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="create-collab-org-name"]')
    ).toBeNull();
  });

  it("submits cloud creation through the shared membership action", async () => {
    signIn();
    mocks.createOrganization.mockResolvedValue({
      orgId: "cloud-org-1",
      name: "Cloud Team",
    });
    await renderForm({ initialSource: "cloud", initialMode: "create" });
    await enterValue("create-collab-org-name", "Cloud Team");
    await submitForm();

    expect(mocks.createOrganization).toHaveBeenCalledWith("Cloud Team");
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("submits cloud join through the shared membership action", async () => {
    signIn();
    mocks.joinOrganization.mockResolvedValue({
      orgId: "cloud-org-2",
      name: "Joined Team",
    });
    await renderForm({ initialSource: "cloud", initialMode: "join" });
    await enterValue("create-collab-org-invite", "orgii://cloud/join#code");
    await submitForm();

    expect(mocks.joinOrganization).toHaveBeenCalledWith(
      "orgii://cloud/join#code"
    );
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("submits local creation without using the cloud actions", async () => {
    mocks.createLocalOrg.mockResolvedValue({ id: "local-org-1" });
    await renderForm();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="create-collab-org-source-local"]'
        )
        ?.click();
    });
    await enterValue("create-collab-org-name", "Local Team");
    await submitForm();

    expect(mocks.createLocalOrg).toHaveBeenCalledWith({ name: "Local Team" });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("Clear resets the guided preset", async () => {
    store.set(guideHighlightAtom, {
      targetId: GUIDE_TARGETS.COLLAB_ORG_NAME_INPUT,
      message: "Create an organization",
      createdAt: 12,
    });
    await renderForm({ initialSource: "cloud", initialMode: "create" });

    const clear = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "common:actions.clear"
    );
    act(() => clear?.click());

    expect(
      container.querySelector('[data-testid="create-collab-org-name"]')
    ).toBeNull();
    expect(store.get(guideHighlightAtom)).toBeNull();
  });
});
