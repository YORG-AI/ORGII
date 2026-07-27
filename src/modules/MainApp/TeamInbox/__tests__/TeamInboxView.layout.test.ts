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

import TeamInboxView from "../TeamInboxView";

const splitViewProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@src/modules/shared/layouts/SplitViewLayout", () => ({
  default: (props: Record<string, unknown>) => {
    splitViewProps.current = props;
    return createElement("div", { "data-testid": "team-inbox-split" });
  },
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => null,
}));

vi.mock("../components", () => ({
  AssignedWorkItemDetail: () => null,
  CommentMentionDetail: () => null,
  TeamInboxList: () => null,
}));

describe("TeamInboxView split layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    splitViewProps.current = null;
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

  it("does not leak the global Code Editor breadcrumb into Team Inbox", () => {
    act(() => {
      root.render(
        createElement(TeamInboxView, {
          dataSource: {
            listPage: () => new Promise<never>(() => undefined),
          },
        })
      );
    });

    expect(splitViewProps.current?.alwaysShowBreadcrumb).toBeUndefined();
    expect(splitViewProps.current?.hideBreadcrumbWhenSidebarCollapsed).toBe(
      true
    );
  });
});
