// @vitest-environment jsdom
import {
  type ReactNode,
  act,
  createElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrichedWorkItem } from "@src/api/http/project";
import type { ProjectDataChange } from "@src/hooks/project/useProjectDataChanged";
import type { ChatPanelSelectedProject } from "@src/store/ui/chatPanelAtom";

import ProjectPanelView from "./ProjectPanelView";

type Props = Record<string, unknown> & { children?: ReactNode };
type Header = { content: ReactNode; trailing: ReactNode };
const mocks = vi.hoisted(() => ({
  props: new Map<string, Props>(),
  publish: (_header: Header) => {},
  changes: new Set<(change: ProjectDataChange | null) => void>(),
  t: (key: string) => key,
  user: {
    currentUser: { id: "member-1", name: "Ada" },
    memberIds: new Set(["member-1"]),
  },
  readProject: vi.fn(),
  writeProject: vi.fn(),
  readOrgs: vi.fn(),
  moveProject: vi.fn(),
  readItems: vi.fn(),
  updateItem: vi.fn(),
  createItem: vi.fn(),
  deleteItem: vi.fn(),
  batchDelete: vi.fn(),
  syncStatus: vi.fn(),
  allocate: vi.fn(),
  openWorkItem: vi.fn(),
  openProject: vi.fn(),
  canAdminister: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  cloudOrgs: [] as unknown[],
}));

function primitive(name: string) {
  return function Primitive(props: Props) {
    mocks.props.set(name, props);
    const values = Object.fromEntries(
      Object.entries(props)
        .filter(
          ([key]) =>
            ![
              "children",
              "containerRef",
              "headerActions",
              "descriptionContent",
              "icon",
            ].includes(key)
        )
        .map(([key, value]) => [
          key,
          typeof value === "function"
            ? "callback"
            : value instanceof Set || value instanceof Map
              ? [...value]
              : isValidElement(value)
                ? "element"
                : value,
        ])
    );
    return createElement(
      "div",
      {
        "data-component": name,
        "data-props": JSON.stringify(values, (_key, value: unknown) => {
          if (isValidElement(value)) return { element: value.props };
          if (typeof value === "function") return "callback";
          return value;
        }),
      },
      props.children,
      props.headerActions as ReactNode,
      props.descriptionContent as ReactNode,
      isValidElement(props.title) ? props.title : null,
      isValidElement(props.tabs) ? props.tabs : null
    );
  };
}

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("jotai", () => ({
  useSetAtom: (atom: string) =>
    atom === "work-item" ? mocks.openWorkItem : mocks.openProject,
  useAtomValue: () => mocks.cloudOrgs,
}));
vi.mock("@src/store/chatPanel/chatPanelTabsAtom", () => ({
  openWorkItemInChatPanelTabAtom: "work-item",
  openProjectInChatPanelTabAtom: "project",
}));
vi.mock("@src/features/Org2Cloud/org2CloudOrgsAtom", () => ({
  org2CloudOrgsAtom: "cloud",
}));
vi.mock("@src/features/Org2Cloud/useProjectOrgCloudPermissions", () => ({
  useProjectOrgCloudPermissions: () => ({ canAdminister: mocks.canAdminister }),
}));
vi.mock("@src/features/Org2Cloud/cloudShortId", () => ({
  allocateCloudAwareWorkItemId: mocks.allocate,
}));
vi.mock("@src/api/http/project", async () => ({
  enrichedWorkItemToUI: (await import("@src/api/http/project/adapters"))
    .enrichedWorkItemToUI,
  projectApi: {
    readProject: mocks.readProject,
    writeProject: mocks.writeProject,
    readOrgs: mocks.readOrgs,
    moveProject: mocks.moveProject,
    readWorkItemsViewData: mocks.readItems,
    updateWorkItemPartial: mocks.updateItem,
    createWorkItem: mocks.createItem,
    deleteWorkItem: mocks.deleteItem,
    batchDeleteWorkItems: mocks.batchDelete,
  },
}));
vi.mock("@src/api/http/project/sync", () => ({
  projectSyncApi: { status: mocks.syncStatus },
}));
vi.mock("@src/hooks/project", () => ({
  useCurrentUserMemberIds: () => mocks.user,
  useProjectDataChanged: (
    callback: (change: ProjectDataChange | null) => void
  ) => {
    useEffect(() => {
      mocks.changes.add(callback);
      return () => {
        mocks.changes.delete(callback);
      };
    }, [callback]);
  },
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@src/engines/ChatPanel/header", () => ({
  usePublishChatPanelHeader: ({ content }: { content: Header }) => {
    useEffect(() => mocks.publish(content), [content]);
  },
}));
vi.mock("@src/icons", () => ({
  UserCircleIcon: "user",
  CancelCircleIcon: "cancel",
  CheckmarkCircle01Icon: "check",
  CircleDashedIcon: "dashed",
  CircleIcon: "circle",
  Clock01Icon: "clock",
  Layers01Icon: "layers",
  AlertCircleIcon: "alert-circle",
  MinusSignIcon: "minus",
  Alert01Icon: "alert",
  HugeiconsIcon: (props: Props) =>
    createElement("i", { "data-icon": props["data-icon"] }),
  ArrowRightDoubleIcon: "right",
  DashboardSquare01Icon: "dashboard",
  DeliveryBox01Icon: "box",
  InformationCircleIcon: "info",
  KanbanIcon: "kanban",
  ListIcon: "list",
  Search01Icon: "search",
}));
vi.mock("@src/components/Button", () => ({ default: primitive("Button") }));
vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: primitive("ToolbarTooltip"),
}));
vi.mock("@src/components/Message", () => ({
  default: { success: mocks.success, error: mocks.error },
}));
vi.mock("@src/components/Placeholder", () => ({
  Placeholder: primitive("Placeholder"),
}));
vi.mock("@src/components/TabPill", () => ({ default: primitive("TabPill") }));
vi.mock("@src/engines/ChatPanel/blocks/primitives", () => ({
  ChatLoadingBlock: primitive("ChatLoadingBlock"),
}));
vi.mock("@src/features/KanbanBoard", async () => ({
  default: primitive("KanbanBoard"),
  GITHUB_ISSUE_KANBAN_COLUMNS: (
    await import("@src/features/KanbanBoard/config")
  ).GITHUB_ISSUE_KANBAN_COLUMNS,
  DEFAULT_KANBAN_COLUMNS: (await import("@src/features/KanbanBoard/config"))
    .DEFAULT_KANBAN_COLUMNS,
}));
vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemContentStack",
  () => ({ default: primitive("WorkItemContentStack") })
);
vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars",
  () => ({ MultiSelectBar: primitive("MultiSelectBar") })
);
vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemsListContent",
  () => ({ default: primitive("WorkItemsListContent") })
);
vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemsStatusFilterSelect",
  () => ({ default: primitive("WorkItemsStatusFilterSelect") })
);
vi.mock("@src/scaffold/GlobalSpotlight/palettes", () => ({
  ContentSearchPalette: primitive("ContentSearchPalette"),
}));
vi.mock(
  "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb",
  () => ({ default: primitive("ProjectManagerBreadcrumb") })
);
vi.mock("@src/modules/ProjectManager/shared", () => ({
  ProjectContentEditor: (props: Props) => {
    mocks.props.set("ProjectContentEditor", props);
    return createElement("textarea", {
      "data-component": "ProjectContentEditor",
      defaultValue: props.initialDescription as string,
    });
  },
  ProjectOrganizationField: primitive("ProjectOrganizationField"),
  ProjectPropertyFields: primitive("ProjectPropertyFields"),
  PropertiesPanel: primitive("PropertiesPanel"),
  PropertiesRailFrame: primitive("PropertiesRailFrame"),
}));
vi.mock("@src/modules/shared/layouts/blocks", async () => ({
  PersistentDetailTabPanel: (
    await import("@src/modules/shared/layouts/blocks/PersistentDetailTabPanel")
  ).default,
  DetailHeaderTabs: primitive("DetailHeaderTabs"),
  DetailPanelContainer: primitive("DetailPanelContainer"),
  DetailTabStrip: primitive("DetailTabStrip"),
  WorkstationTrailIconButton: primitive("WorkstationTrailIconButton"),
  WorkstationTrailSurface: primitive("WorkstationTrailSurface"),
}));

const selectedProject: ChatPanelSelectedProject = {
  projectSlug: "project-one",
  orgId: "personal-org",
  orgName: "Personal",
  project: {
    id: "project-id",
    name: "Project One",
    slug: "fallback-slug",
    description: "Project One",
    workItemPrefix: "ONE",
    status: "planned",
    priority: "none",
    health: "on_track",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    members: [{ id: "member-1", name: "Ada" }],
    labels: [],
    linkedRepos: [{ id: "repo-id", name: "Repo", path: "/fixture/repo" }],
  },
};
function item(
  id = "item-id",
  title = "First task",
  status = "planned"
): EnrichedWorkItem {
  return {
    id,
    shortId: id === "item-id" ? "ONE-1" : "ONE-2",
    title,
    status,
    body: "Body",
    filename: "item.md",
    priority: "none",
    starred: false,
    labels: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    assignee: { id: "member-1", name: "Ada", color: "#3b82f6" },
    todos: [],
    comments: [],
    history: [],
    linkedSessions: [],
    followUpItems: [],
    workProducts: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function invoke(name: string, action: string, ...args: unknown[]) {
  const callback = mocks.props.get(name)?.[action];
  expect(callback, `${name}.${action}`).toBeTypeOf("function");
  return (callback as (...values: unknown[]) => unknown)(...args);
}
function Harness({
  selection = selectedProject,
}: {
  selection?: ChatPanelSelectedProject;
}) {
  const [header, setHeader] = useState<Header | null>(null);
  useLayoutEffect(() => {
    mocks.publish = setHeader;
  }, []);
  return createElement(
    "main",
    null,
    createElement("header", null, header?.content, header?.trailing),
    createElement(ProjectPanelView, { selectedProject: selection })
  );
}

describe("ProjectPanelView behavior contract", () => {
  let container: HTMLDivElement;
  let root: Root;
  let unmounted: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.props.clear();
    mocks.changes.clear();
    mocks.canAdminister.mockReturnValue(true);
    mocks.readProject.mockResolvedValue({
      description: " Saved overview ",
      meta: { id: "project-id", name: "Project One" },
    });
    mocks.readOrgs.mockResolvedValue([
      { id: "personal-org", name: "Personal" },
      { id: "destination", name: "Destination" },
    ]);
    mocks.syncStatus.mockResolvedValue({ adapter_id: null });
    mocks.readItems.mockResolvedValue({
      items: [item(), item("second-id", "Second task", "completed")],
    });
    mocks.updateItem.mockResolvedValue(
      item("item-id", "First task", "in_progress")
    );
    mocks.allocate.mockResolvedValue("ONE-9");
    mocks.createItem.mockResolvedValue(undefined);
    mocks.moveProject.mockResolvedValue(undefined);
    mocks.batchDelete.mockResolvedValue({ deleted: ["ONE-1"], errors: [] });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    unmounted = false;
  });
  afterEach(() => {
    if (!unmounted) act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  async function render(selection?: ChatPanelSelectedProject) {
    await act(async () => {
      root.render(createElement(Harness, { selection }));
    });
  }
  async function tab(tab: string) {
    await act(async () => {
      invoke("DetailTabStrip", "onChange", tab);
    });
  }

  it("preserves initial list, loading, error/retry, and empty view contracts", async () => {
    const pending = deferred<{ items: EnrichedWorkItem[] }>();
    mocks.readItems.mockReturnValueOnce(pending.promise);
    await render();
    expect(mocks.readProject).toHaveBeenCalledWith("project-one");
    expect(mocks.readOrgs).toHaveBeenCalledTimes(1);
    expect(mocks.readItems).toHaveBeenCalledWith("project-one", {
      view: "list",
    });
    expect(container.innerHTML).toMatchSnapshot("loading list");
    await act(async () => pending.reject(new Error("Unavailable")));
    expect(mocks.props.get("Placeholder")).toMatchObject({
      variant: "error",
      title: "Unavailable",
      fillParentHeight: true,
    });
    expect(container.innerHTML).toMatchSnapshot("error list");
    mocks.readItems.mockResolvedValueOnce({ items: [] });
    await act(async () => {
      await (
        mocks.props.get("Placeholder")?.action as {
          onClick: () => Promise<void>;
        }
      ).onClick();
    });
    expect(container.innerHTML).toMatchSnapshot("empty list");
    expect(mocks.readItems).toHaveBeenCalledTimes(2);
  });

  it("keeps list/Kanban rendering, navigation, status grouping, search and selection", async () => {
    await render();
    expect(container.innerHTML).toMatchSnapshot("loaded list");
    expect(mocks.props.get("WorkItemsListContent")).toMatchObject({
      readonly: true,
      disableProjectEdit: true,
      compactRows: true,
      selectedWorkItemId: null,
      workItemPrefix: "ONE",
    });
    await act(async () => {
      invoke("WorkItemsListContent", "onSelectWorkItem", "item-id");
    });
    expect(mocks.openWorkItem).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "project-id",
        projectName: "Project One",
        projectSlug: "project-one",
        shortId: "ONE-1",
        orgId: "personal-org",
        orgName: "Personal",
        sourceProject: selectedProject,
        workItem: expect.objectContaining({ session_id: "item-id" }),
      })
    );
    await act(async () => {
      invoke("WorkItemsListContent", "onCheckedChange", "item-id", true);
    });
    await tab("kanban");
    expect(container.innerHTML).toMatchSnapshot("kanban with selected row");
    expect(mocks.props.get("MultiSelectBar")).toMatchObject({
      selectedCount: 1,
      visibleItemCount: 2,
    });
    await act(async () => {
      invoke("KanbanBoard", "onTaskClick", { id: "item-id" });
    });
    expect(mocks.openWorkItem).toHaveBeenCalledTimes(2);
    await act(async () => {
      invoke("TabPill", "onChange", "assigned_to");
    });
    expect(mocks.props.get("KanbanBoard")).toMatchObject({
      allowTaskDrag: false,
      showAddButton: false,
      allowColumnReorder: false,
    });
    await act(async () => {
      invoke("KanbanBoard", "onTaskMove", "item-id", "completed");
    });
    expect(mocks.updateItem).not.toHaveBeenCalled();
    await act(async () => {
      invoke("ContentSearchPalette", "onQueryChange", "second");
    });
    await tab("list");
    expect(mocks.props.get("WorkItemsListContent")?.filteredWorkItems).toEqual([
      expect.objectContaining({ session_id: "second-id" }),
    ]);
    expect(mocks.readItems).toHaveBeenCalledTimes(1);
  });

  it("retains the overview editor and a pending 500ms save when another tab is selected", async () => {
    await render();
    expect(container.querySelector("textarea")).toBeNull();
    await tab("overview");
    const editor = container.querySelector("textarea");
    expect(editor?.value).toBe("Saved overview");
    expect(mocks.props.get("ProjectContentEditor")).toMatchObject({
      title: "Project One",
      titleVisible: false,
      separatorVisible: false,
      editable: true,
      repoPath: "/fixture/repo",
      descriptionClassName: "no-bottom-border",
      className: "w-full",
    });
    expect(container.innerHTML).toMatchSnapshot("overview");
    await act(async () => {
      invoke("ProjectContentEditor", "onDescriptionChange", "Draft text");
    });
    await tab("list");
    expect(container.querySelector("textarea")).toBe(editor);
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(mocks.writeProject).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.writeProject).toHaveBeenCalledWith(
      "project-one",
      { id: "project-id", name: "Project One", updated_at: expect.any(String) },
      "Draft text"
    );
    await tab("overview");
    expect(container.querySelector("textarea")).toBe(editor);
    await act(async () => {
      invoke("ProjectContentEditor", "onDescriptionChange", "Cancelled draft");
    });
    act(() => root.unmount());
    unmounted = true;
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(mocks.writeProject).toHaveBeenCalledTimes(1);
    expect(mocks.changes.size).toBe(0);
  });

  it("keeps organization permission, in-flight move, destination navigation and hidden-rail state", async () => {
    await render();
    const pending = deferred<void>();
    mocks.moveProject.mockReturnValueOnce(pending.promise);
    await act(async () => {
      invoke("ProjectOrganizationField", "onChange", "destination");
    });
    expect(mocks.props.get("ProjectOrganizationField")?.disabled).toBe(true);
    await act(async () => {
      invoke("WorkstationTrailIconButton", "onClick");
    });
    expect(
      container.querySelector('[data-component="PropertiesPanel"]')
    ).toBeNull();
    expect(mocks.readOrgs).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    expect(mocks.openProject).toHaveBeenCalledWith({
      ...selectedProject,
      orgId: "destination",
      orgName: "Destination",
    });
    expect(mocks.success).toHaveBeenCalledWith("Moved project to Destination");
    await act(async () => {
      invoke("Button", "onClick");
    });
    expect(mocks.props.get("ProjectOrganizationField")?.disabled).toBe(false);
    expect(mocks.readOrgs).toHaveBeenCalledTimes(1);
    mocks.canAdminister.mockReturnValue(false);
    await render();
    expect(mocks.props.get("ProjectOrganizationField")?.disabled).toBe(true);
  });

  it("uses short IDs for edits/deletes and awaits cloud allocation before creating and refreshing", async () => {
    await render();
    await tab("kanban");
    await act(async () => {
      invoke("KanbanBoard", "onTaskMove", "item-id", "in_progress");
    });
    expect(mocks.updateItem).toHaveBeenCalledWith("project-one", "ONE-1", {
      status: "in_progress",
      actor: { id: "member-1", name: "Ada" },
    });
    expect(mocks.props.get("KanbanBoard")?.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "item-id", status: "in_progress" }),
      ])
    );
    const allocation = deferred<string>();
    mocks.allocate.mockReturnValueOnce(allocation.promise);
    await act(async () => {
      invoke("KanbanBoard", "onAddTask", "completed");
    });
    expect(mocks.allocate).toHaveBeenCalledWith("project-one");
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.readItems).toHaveBeenCalledTimes(1);
    await act(async () => allocation.resolve("CLOUD-99"));
    expect(mocks.createItem).toHaveBeenCalledWith("project-one", "CLOUD-99", {
      title: "projects:workItems.newWorkItemName",
      projectId: "project-id",
      status: "completed",
    });
    expect(mocks.readItems).toHaveBeenCalledTimes(2);
    await tab("list");
    await act(async () => {
      invoke("WorkItemsListContent", "onCheckedChange", "item-id", true);
    });
    await act(async () => {
      await invoke("MultiSelectBar", "onDelete");
    });
    expect(mocks.batchDelete).toHaveBeenCalledWith("project-one", ["ONE-1"]);
    expect(mocks.readItems).toHaveBeenCalledTimes(3);
  });

  it("refreshes for matching/unscoped events without adding requests on tab or rail changes", async () => {
    await render();
    expect(mocks.changes.size).toBe(1);
    await act(async () => {
      mocks.changes.forEach((callback) => callback({ projectSlug: "other" }));
    });
    expect(mocks.readItems).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.changes.forEach((callback) =>
        callback({ projectSlug: "project-one" })
      );
    });
    await act(async () => {
      mocks.changes.forEach((callback) => callback(null));
    });
    expect(mocks.readItems).toHaveBeenCalledTimes(3);
    await tab("overview");
    await tab("kanban");
    await act(async () => {
      invoke("WorkstationTrailIconButton", "onClick");
    });
    expect(mocks.readItems).toHaveBeenCalledTimes(3);
  });
  it("keeps overview and sync completion guards across project changes", async () => {
    const oldBody = deferred<{ description: string; meta: { id: string } }>();
    const oldSync = deferred<{ adapter_id: string | null }>();
    mocks.readProject.mockReturnValueOnce(oldBody.promise);
    mocks.syncStatus.mockReturnValueOnce(oldSync.promise);
    await render();
    await tab("overview");
    expect(container.querySelector("textarea")).toBeNull();
    const nextSelection = {
      ...selectedProject,
      projectSlug: "project-two",
      project: { ...selectedProject.project, id: "second-project" },
    };
    mocks.readProject.mockResolvedValueOnce({
      description: "Second overview",
      meta: { id: "second-project" },
    });
    mocks.syncStatus.mockResolvedValueOnce({ adapter_id: "github" });
    await render(nextSelection);
    expect(container.querySelector("textarea")?.value).toBe("Second overview");
    expect(
      container.querySelector('[data-component="ProjectPropertyFields"]')
    ).toBeNull();
    await act(async () => {
      oldBody.resolve({
        description: "Stale overview",
        meta: { id: "project-id" },
      });
      oldSync.resolve({ adapter_id: null });
    });
    expect(container.querySelector("textarea")?.value).toBe("Second overview");
    expect(
      container.querySelector('[data-component="ProjectPropertyFields"]')
    ).toBeNull();
    expect(mocks.writeProject).not.toHaveBeenCalled();
  });

  it("preserves overview errors and status-filter reset after refreshed source statuses change", async () => {
    mocks.readProject.mockRejectedValueOnce(new Error("Body unavailable"));
    await render();
    await tab("overview");
    expect(mocks.props.get("Placeholder")).toMatchObject({
      title: "Body unavailable",
      variant: "error",
      fillParentHeight: true,
    });
    expect(container.querySelector("textarea")).toBeNull();
    await tab("list");
    await act(async () => {
      invoke("WorkItemsStatusFilterSelect", "onChange", "todo");
    });
    mocks.readItems.mockResolvedValueOnce({
      items: [item("item-id", "GitHub issue", "open")],
    });
    await act(async () => {
      mocks.changes.forEach((callback) => callback(null));
    });
    expect(mocks.props.get("WorkItemsStatusFilterSelect")?.value).toBe("all");
    expect(mocks.props.get("WorkItemsStatusFilterSelect")?.filterKeys).toEqual([
      "all",
      "open",
      "closed",
    ]);
  });

  it("preserves search shortcut ownership and disposes window listeners on close", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    await render();
    const outside = document.createElement("button");
    outside.setAttribute("data-workbench-surface", "editor");
    document.body.appendChild(outside);
    outside.focus();
    const outsideFind = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(outsideFind);
    });
    expect(outsideFind.defaultPrevented).toBe(false);
    expect(mocks.props.get("ContentSearchPalette")?.isOpen).toBe(false);
    const pane = container.querySelector(
      '[data-testid="chat-panel-project-detail"]'
    )!;
    pane.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const insideFind = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(insideFind);
    });
    expect(insideFind.defaultPrevented).toBe(true);
    expect(mocks.props.get("ContentSearchPalette")?.isOpen).toBe(true);
    await act(async () => {
      invoke("ContentSearchPalette", "onClose");
    });
    await tab("overview");
    const overviewFind = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(overviewFind);
    });
    expect(overviewFind.defaultPrevented).toBe(false);
    act(() => root.unmount());
    unmounted = true;
    const paneListeners = added.mock.calls.filter(([name]) =>
      ["pointerdown", "focusin", "keydown"].includes(name)
    );
    for (const args of paneListeners)
      expect(removed).toHaveBeenCalledWith(...args);
    outside.remove();
    added.mockRestore();
    removed.mockRestore();
  });
});
