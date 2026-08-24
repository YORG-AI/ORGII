// @vitest-environment jsdom
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

import { CloudOrgMembershipActionFailure } from "@src/features/Org2Cloud/useCloudOrgMembershipActions";

import { WebSessionsPage } from "./WebSessionsPage";

const mocks = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  joinOrganization: vi.fn(),
  messageSuccess: vi.fn(),
  roster: {
    status: "loaded" as "idle" | "loading" | "loaded" | "error",
    sessions: [],
    error: null as string | null,
    failedOrganizationCount: 0,
    organizationStatus: "ready" as
      | "idle"
      | "loading"
      | "retrying"
      | "ready"
      | "error",
    organizationsKnown: true,
    hasOrganizations: false,
    refresh: vi.fn(async () => undefined),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/Message", () => ({
  default: { success: mocks.messageSuccess },
}));

vi.mock(
  "@src/features/Org2Cloud/useCloudOrgMembershipActions",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@src/features/Org2Cloud/useCloudOrgMembershipActions")
      >();
    return {
      ...actual,
      useCloudOrgMembershipActions: () => ({
        createOrganization: mocks.createOrganization,
        joinOrganization: mocks.joinOrganization,
      }),
    };
  }
);

vi.mock("./WebSessionsContext", () => ({
  useWebSessions: () => mocks.roster,
}));

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WebSessionsPage first-use flow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.roster.status = "loaded";
    mocks.roster.error = null;
    mocks.roster.organizationStatus = "ready";
    mocks.roster.organizationsKnown = true;
    mocks.roster.hasOrganizations = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderPage() {
    act(() => root.render(createElement(WebSessionsPage)));
  }

  function typeOrganizationValue(value: string) {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="web-organization-input"]'
    );
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders organization setup instead of the synced-session empty state", () => {
    renderPage();

    expect(
      container.querySelector('[data-testid="web-organization-onboarding"]')
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "web.sessionsPage.organizationSetupTitle"
    );
    expect(container.textContent).not.toContain("web.sessionsPage.emptyHint");
  });

  it("keeps a failed first roster load in the retryable error state", () => {
    mocks.roster.status = "error";
    mocks.roster.error = "organization unavailable";
    mocks.roster.organizationStatus = "error";
    mocks.roster.organizationsKnown = false;
    renderPage();

    expect(
      container.querySelector('[data-testid="web-organization-onboarding"]')
    ).toBeNull();
    expect(container.textContent).toContain("web.sessionsPage.loadError");
    act(() => {
      Array.from(container.querySelectorAll("button"))
        .find((button) =>
          button.textContent?.includes("web.sessionsPage.retry")
        )
        ?.click();
    });
    expect(mocks.roster.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a known empty roster actionable when a later refresh fails", () => {
    mocks.roster.error = "refresh unavailable";
    mocks.roster.organizationStatus = "error";
    renderPage();

    expect(
      container.querySelector('[data-testid="web-organization-onboarding"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="web-organization-refresh-error"]')
        ?.textContent
    ).toContain("refresh unavailable");
  });

  it("creates an organization through the shared membership command boundary", async () => {
    mocks.createOrganization.mockResolvedValue({
      orgId: "org-1",
      name: "Acme",
      role: "owner",
    });
    renderPage();
    typeOrganizationValue("  Acme  ");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="web-organization-submit"]'
        )
        ?.click();
    });
    await flushAsync();

    expect(mocks.createOrganization).toHaveBeenCalledWith("Acme");
    expect(mocks.messageSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps a rejected invite actionable and shows its source error", async () => {
    mocks.joinOrganization.mockRejectedValue(
      new CloudOrgMembershipActionFailure("invalid_invite")
    );
    renderPage();
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="web-organization-mode-join"]'
        )
        ?.click();
    });
    typeOrganizationValue("bad-invite");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="web-organization-submit"]'
        )
        ?.click();
    });
    await flushAsync();

    expect(mocks.joinOrganization).toHaveBeenCalledWith("bad-invite");
    expect(
      container.querySelector('[data-testid="web-organization-error"]')
        ?.textContent
    ).toBe("cloud.orgManagement.errors.inviteInvalid");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="web-organization-submit"]'
      )?.disabled
    ).toBe(false);
  });

  it("keeps the Desktop sync guidance for members whose org has no sessions", () => {
    mocks.roster.hasOrganizations = true;
    renderPage();

    expect(
      container.querySelector('[data-testid="web-organization-onboarding"]')
    ).toBeNull();
    expect(container.textContent).toContain("web.sessionsPage.emptyHint");
  });
});
