// @vitest-environment jsdom
import { Provider, atom } from "jotai";
import { act, createElement, useEffect } from "react";
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

import type { ProjectData } from "@src/api/http/project";

import { useProjectsWorkItemMenuItems } from "./index";
import type { UseProjectsWorkItemMenuItemsResult } from "./types";

const mocks = vi.hoisted(() => ({
  readOrgs: vi.fn(),
  readProjects: vi.fn(),
  readLabels: vi.fn(),
  readMembers: vi.fn(),
  readWorkItemsViewData: vi.fn(),
  status: vi.fn(),
}));

const translate = (key: string) => key;

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readOrgs: mocks.readOrgs,
    readProjects: mocks.readProjects,
    readLabels: mocks.readLabels,
    readMembers: mocks.readMembers,
    readWorkItemsViewData: mocks.readWorkItemsViewData,
  },
  enrichedWorkItemToUI: vi.fn(),
  projectDataToUI: vi.fn(),
}));
vi.mock("@src/api/http/project/sync", () => ({
  projectSyncApi: { status: mocks.status },
}));
vi.mock("@src/features/Org2Cloud/org2CloudProjectOrgAlias", () => ({
  COLLAB_SYNC_PROVIDER: "collab",
}));
vi.mock("@src/hooks/project", () => ({
  useProjectDataChanged: vi.fn(),
}));
vi.mock("@src/hooks/project/useCollabOutboxPending", () => ({
  useCollabOutboxPending: () => ({ pendingProjectIds: new Set() }),
}));
vi.mock(
  "@src/modules/ProjectManager/LinearProjects/linearProjectsCache",
  () => ({
    cachedLinearProjectsApi: {
      listProjects: vi.fn(),
      listProjectIssues: vi.fn(),
    },
  })
);
vi.mock("@src/modules/ProjectManager/LinearProjects/utils", () => ({
  linearIssueToWorkItem: vi.fn(),
}));
vi.mock("@src/store/workstation/tabs", () => ({
  PROJECT_ORG_SURFACE_VIEW: { WORK_ITEMS: "work-items" },
  STORY_ORG_SCOPE: {
    PERSONAL_ORG: "personal-org",
    PROJECT_ORG: "project-org",
  },
  createProjectLinearWorkItemsTab: vi.fn(),
  createProjectOrgTab: vi.fn(),
  openWorkstationTabAtom: atom(null, () => undefined),
  presentedWorkstationWorkspaceKeyAtom: atom({ kind: "global" }),
}));
vi.mock("@src/store/workstation/tabs/factories/project", () => ({
  STORY_PERSONAL_ORG_FILTER_ID: "personal",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

const project = {
  slug: "orgii-issues",
  description: "",
  meta: {
    id: "project-id",
    name: "ORGII issues",
    org_id: "",
    updated_at: "2026-09-03T00:00:00.000Z",
  },
} as ProjectData;

describe("useProjectsWorkItemMenuItems", () => {
  let root: Root;
  let result: UseProjectsWorkItemMenuItemsResult | undefined;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  function Probe() {
    const value = useProjectsWorkItemMenuItems({
      enabled: true,
      groupVisibleCounts: new Map(),
      searchQuery: "",
    });
    useEffect(() => {
      result = value;
    }, [value]);
    return null;
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOrgs.mockResolvedValue([]);
    mocks.readProjects.mockResolvedValue([project]);
    mocks.readLabels.mockResolvedValue({ labels: [] });
    mocks.readMembers.mockResolvedValue({ members: [] });
    mocks.status.mockResolvedValue({ adapter_id: "github" });
    mocks.readWorkItemsViewData.mockResolvedValue({ items: [] });
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    result = undefined;
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does not hydrate work items while building the project sidebar", async () => {
    await act(async () => {
      root.render(createElement(Provider, null, createElement(Probe)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.readWorkItemsViewData).not.toHaveBeenCalled();
    expect(result?.menuItems.map((item) => item.id)).toEqual([
      "separator-recent-projects",
      "projects-project-overview:orgii-issues",
    ]);
    expect(result?.workItemMap.size).toBe(0);
  });
});
