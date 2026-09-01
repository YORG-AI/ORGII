// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatPanelAccessReconciliation } from "./useChatPanelAccessReconciliation";

const mocks = vi.hoisted(() => ({
  loaded: false,
  roster: [] as { orgId: string }[],
  selected: null as { orgId: string } | null,
  readOrgs: vi.fn(),
  closeOrganization: vi.fn(),
  closeProjectOrgs: vi.fn(),
  closeChannels: vi.fn(),
}));

vi.mock("jotai", () => ({
  useAtomValue: (atom: string) =>
    atom === "roster"
      ? mocks.roster
      : atom === "loaded"
        ? mocks.loaded
        : mocks.selected,
  useSetAtom: (atom: string) =>
    atom === "closeOrganization"
      ? mocks.closeOrganization
      : atom === "closeProjectOrgs"
        ? mocks.closeProjectOrgs
        : mocks.closeChannels,
}));
vi.mock("@src/api/http/project", () => ({
  projectApi: { readOrgs: mocks.readOrgs },
}));
vi.mock("@src/features/Org2Cloud/org2CloudOrgsAtom", () => ({
  org2CloudOrgsAtom: "roster",
  org2CloudOrgsLoadedAtom: "loaded",
}));
vi.mock("@src/store/chatPanel/chatPanelTabsAtom", () => ({
  closeOrganizationChatPanelTabAtom: "closeOrganization",
  closeProjectOrgChatPanelTabsAtom: "closeProjectOrgs",
  closeRevokedCloudChannelChatPanelTabsAtom: "closeChannels",
}));
function Harness() {
  useChatPanelAccessReconciliation(mocks.selected);
  return null;
}

describe("chat tab access reconciliation lifetime", () => {
  let root: Root;
  let container: HTMLDivElement;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.loaded = false;
    mocks.roster = [];
    mocks.selected = { orgId: "revoked" };
    mocks.readOrgs.mockResolvedValue([]);
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("waits for an authoritative roster before closing any tabs", async () => {
    await act(async () => root.render(createElement(Harness)));
    expect(mocks.readOrgs).not.toHaveBeenCalled();
    expect(mocks.closeOrganization).not.toHaveBeenCalled();
    expect(mocks.closeProjectOrgs).not.toHaveBeenCalled();
    expect(mocks.closeChannels).not.toHaveBeenCalled();
  });

  it("reconciles all tab types even when no visible content is rendered", async () => {
    mocks.loaded = true;
    mocks.roster = [{ orgId: "retained" }];
    mocks.readOrgs.mockResolvedValue([
      {
        id: "gone-alias",
        sync_provider: "orgii_collab",
        external_org_id: "revoked",
      },
      {
        id: "live-alias",
        sync_provider: "orgii_collab",
        external_org_id: "retained",
      },
      { id: "local", sync_provider: null, external_org_id: null },
    ]);
    await act(async () => root.render(createElement(Harness)));
    expect(container.childNodes).toHaveLength(0);
    expect(mocks.closeOrganization).toHaveBeenCalledOnce();
    expect(mocks.closeProjectOrgs).toHaveBeenCalledWith(["gone-alias"]);
    expect(mocks.closeChannels).toHaveBeenCalledWith(["retained"]);
  });

  it("discards old roster lookups after scope changes and disposal", async () => {
    type Alias = { id: string; sync_provider: string; external_org_id: string };
    const resolvers: ((value: Alias[]) => void)[] = [];
    mocks.loaded = true;
    mocks.readOrgs.mockImplementation(
      () => new Promise<Alias[]>((resolve) => resolvers.push(resolve))
    );
    await act(async () => root.render(createElement(Harness)));
    mocks.roster = [{ orgId: "new-scope" }];
    await act(async () => root.render(createElement(Harness)));
    const staleAlias = [
      { id: "alias", sync_provider: "orgii_collab", external_org_id: "gone" },
    ];
    await act(async () => resolvers[0](staleAlias));
    expect(mocks.closeProjectOrgs).not.toHaveBeenCalled();
    act(() => root.render(null));
    await act(async () => resolvers[1](staleAlias));
    expect(mocks.closeProjectOrgs).not.toHaveBeenCalled();
    expect(mocks.readOrgs).toHaveBeenCalledTimes(2);
  });
});
