import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudOrgMember } from "../org2CloudClient";
import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type { CommentThread } from "../org2CloudSessionCommentsAtom";
import CommentThreadList from "./CommentThreadList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
  }),
}));

vi.mock("@src/components/ComposerSurface", () => ({
  default: ({
    children,
    leadingActions,
    trailingActions,
    variant,
  }: {
    children?: ReactNode;
    leadingActions?: ReactNode;
    trailingActions?: ReactNode;
    variant?: string;
  }) =>
    createElement(
      "section",
      {
        "data-testid": "shared-composer-surface",
        "data-variant": variant,
      },
      createElement("div", { "data-slot": "editor" }, children),
      createElement("div", { "data-slot": "leading" }, leadingActions),
      createElement("div", { "data-slot": "trailing" }, trailingActions)
    ),
}));

vi.mock("@src/components/Dropdown", () => ({
  default: ({
    children,
    className,
    onVisibleChange,
  }: {
    children?: ReactNode;
    className?: string;
    onVisibleChange?: (visible: boolean) => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "member-dropdown",
        "data-panel-class": className,
        "data-has-visible-change": typeof onVisibleChange === "function",
      },
      children
    ),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: ({
    dataTestId,
    maxLength,
    disabled,
  }: {
    dataTestId?: string;
    maxLength?: number;
    disabled?: boolean;
  }) =>
    createElement("div", {
      "data-testid": dataTestId,
      "data-editor-kind": "markdown-textarea",
      "data-max-length": maxLength,
      "data-disabled": String(Boolean(disabled)),
    }),
}));

vi.mock("@src/modules/shared/components/MarkdownContent", () => ({
  MarkdownContent: ({ body }: { body: string }) =>
    createElement("div", {
      "data-testid": "shared-markdown-content",
      "data-body": body,
    }),
}));

const MEMBER: CloudOrgMember = {
  userId: "member-1",
  displayName: "Ada",
  role: "member",
  status: "active",
};

function renderList(
  props: Partial<Parameters<typeof CommentThreadList>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(CommentThreadList, {
      threads: [],
      viewerUserId: "viewer-1",
      viewerIsAdmin: false,
      mentionableMembers: [MEMBER],
      onComposerCancel: vi.fn(),
      onAdd: vi.fn(async () => undefined),
      onEdit: vi.fn(async () => undefined),
      onDelete: vi.fn(async () => undefined),
      onResolve: vi.fn(async () => undefined),
      ...props,
    })
  );
}

describe("CommentThreadList presentation", () => {
  it("uses the lightweight Markdown composer with contained actions", () => {
    const markup = renderList();

    expect(markup).toContain('data-testid="shared-composer-surface"');
    expect(markup).toContain('data-variant="default"');
    expect(markup).toContain('data-testid="session-comment-composer-editor"');
    expect(markup).toContain('data-editor-kind="markdown-textarea"');
    expect(markup).toContain('data-max-length="4000"');
    expect(markup).toContain('data-disabled="false"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="listbox"');

    const leadingActions = markup.slice(
      markup.indexOf('data-slot="leading"'),
      markup.indexOf('data-slot="trailing"')
    );
    const trailingActions = markup.slice(
      markup.indexOf('data-slot="trailing"')
    );
    expect(leadingActions).toContain(
      'data-testid="session-comment-composer-mode-switch"'
    );
    expect(leadingActions).not.toContain('data-testid="member-dropdown"');
    expect(trailingActions).toContain('data-testid="member-dropdown"');
    expect(trailingActions).toContain(
      'data-testid="session-comment-composer-cancel"'
    );
    expect(trailingActions).toContain(
      'data-testid="session-comment-composer-submit"'
    );
  });

  it("wraps the member picker in the reusable dropdown panel tokens", () => {
    const markup = renderList();

    expect(markup).toContain('data-has-visible-change="true"');
    const panel = markup.match(/data-panel-class="([^"]+)"/)?.[1] ?? "";
    expect(panel).toContain("bg-bg-2");
    expect(panel).toContain("border-border-2");
    expect(panel).toContain("rounded-lg");
    expect(panel).toContain("shadow-dropdown");
    expect(panel).toContain("min-w-[280px]");
  });

  it("renders saved comment bodies through the shared Markdown renderer", () => {
    const comment: CloudSessionComment = {
      id: "comment-1",
      authorUserId: "member-1",
      authorDisplayName: "Ada",
      body: "**bold** comment",
      createdAt: "2026-08-14T00:00:00.000Z",
      kind: "user",
    };
    const thread: CommentThread = { top: comment, replies: [] };

    const markup = renderList({ threads: [thread], showComposer: false });

    expect(markup).toContain('data-testid="shared-markdown-content"');
    expect(markup).toContain('data-body="**bold** comment"');
  });
});
