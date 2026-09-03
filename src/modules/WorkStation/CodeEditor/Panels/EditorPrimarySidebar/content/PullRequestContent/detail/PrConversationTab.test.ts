// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrConversationTab } from "./PrConversationTab";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@src/features/Org2Cloud/useSessionReferenceDropTarget", () => ({
  useSessionReferenceDropTarget: () => ({ isDragOver: false }),
}));

vi.mock("@src/hooks/ui/layout/useElementDimensions", () => ({
  useElementDimensions: () => 0,
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef<HTMLDivElement, Record<string, unknown>>(
      function MockMarkdownTextareaEditor(props, ref) {
        return createElement("div", {
          ref,
          "data-testid": props.dataTestId,
          "data-min-height": props.minHeight,
          "data-max-height": props.maxHeight,
          "data-appearance": props.appearance,
          "data-editor-kind": "write-preview",
          "data-value": props.value,
        });
      }
    ),
  };
});

describe("PrConversationTab", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("lays out the flow header, timeline, and floating composer", () => {
    const markup = renderToStaticMarkup(
      createElement(PrConversationTab, {
        detail: null,
        identity: {
          number: 42,
          title: "Match the issue composer",
          url: "https://github.com/org/repo/pull/42",
          status: "open",
          headBranch: "feature/comments",
        },
        conversation: [],
        reviews: [],
        reviewComments: [],
        loading: false,
        submittingComment: false,
        submittingReview: false,
        flowHeader: createElement(
          "div",
          { "data-testid": "pr-flow-header" },
          "Match the issue composer #42"
        ),
        onAddComment: vi.fn().mockResolvedValue(undefined),
        onSubmitReview: vi.fn().mockResolvedValue(undefined),
      })
    );
    const container = document.createElement("div");
    container.innerHTML = markup;

    const scrollRegion = container.querySelector(
      '[data-testid="pr-conversation-scroll"]'
    );
    const composer = container.querySelector(
      '[data-testid="pr-comment-composer"]'
    );
    const floatingComposer = container.querySelector(
      '[data-testid="pr-floating-composer"]'
    );
    const editor = composer?.querySelector('[data-testid="pr-comment-editor"]');
    const flowHeader = container.querySelector(
      '[data-testid="pr-flow-header"]'
    );
    const input = composer?.querySelector(
      '[data-testid="pr-comment-drop-target"]'
    );
    const actionRow = input?.lastElementChild;
    const submitReviewButton = input?.querySelector<HTMLButtonElement>(
      '[data-testid="pr-submit-review"]'
    );
    const modeSwitch = input?.querySelector(
      '[data-testid="pr-comment-mode-switch"]'
    );
    const commentButton = Array.from(
      input?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).find((button) => button.textContent?.trim() === "Comment");

    expect(composer).not.toBeNull();
    expect(composer?.className).toContain("gap-1.5");
    expect(scrollRegion?.contains(composer)).toBe(false);
    expect(floatingComposer?.contains(composer)).toBe(true);
    expect(floatingComposer?.className).toContain("absolute");
    expect(floatingComposer?.className).toContain("bottom-0");
    expect(floatingComposer?.className).toContain("pb-3");
    expect(composer?.parentElement?.className).toContain("px-4");
    expect(composer?.parentElement?.className).toContain("max-w-[932px]");
    expect(scrollRegion?.firstElementChild?.getAttribute("style")).toContain(
      "padding-bottom:240px"
    );

    // Flow header sits above the timeline inside the scrolling region; the
    // operations sidebar renders at the panel level, not inside this tab.
    expect(scrollRegion?.contains(flowHeader)).toBe(true);
    expect(container.querySelector('[data-testid="pr-sidebar"]')).toBeNull();

    expect(editor?.getAttribute("data-min-height")).toBe("100");
    expect(editor?.getAttribute("data-max-height")).toBe("500");
    expect(editor?.getAttribute("data-appearance")).toBe("plain");
    expect(editor?.getAttribute("data-editor-kind")).toBe("write-preview");
    // Guards against the pinned composer bar (a border-t wrapper) coming
    // back; its old flex-shrink-0 spelling no longer exists post-Tailwind-v4.
    expect(composer?.querySelector(".border-t")).toBeNull();
    expect(input?.textContent).toContain("Submit review");
    expect(input?.textContent).toContain("Comment");
    expect(modeSwitch).not.toBeNull();
    expect(
      modeSwitch?.compareDocumentPosition(submitReviewButton as Node)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(submitReviewButton?.parentElement).toBe(
      commentButton?.parentElement
    );
    expect(submitReviewButton?.style.height).toBe("28px");
    expect(commentButton?.style.height).toBe("28px");
    expect(actionRow?.className).not.toContain("border-t");
    expect(input?.className).toContain("px-1.5");
    expect(input?.className).toContain("pt-1.5!");
    expect(input?.className).toContain("pb-1.5");
    expect(actionRow?.className).toContain("px-1");
    expect(composer?.textContent).toContain("Submit review");
    expect(composer?.textContent).toContain("Comment");
  });

  it("submits the selected review decision from the modal", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSubmitReview = vi.fn().mockResolvedValue(undefined);
    const onDraftChange = vi.fn();

    try {
      await act(async () => {
        root.render(
          createElement(PrConversationTab, {
            detail: null,
            identity: {
              number: 42,
              title: "Review in a modal",
              url: "https://github.com/org/repo/pull/42",
              status: "open",
              headBranch: "feature/review-modal",
            },
            conversation: [],
            reviews: [],
            reviewComments: [],
            loading: false,
            submittingComment: false,
            submittingReview: false,
            draft: "Keep this conversation draft",
            onDraftChange,
            onAddComment: vi.fn().mockResolvedValue(undefined),
            onSubmitReview,
          })
        );
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="pr-submit-review"]')
          ?.click();
      });

      const dialog =
        document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("Submit review");
      expect(dialog?.querySelector("legend")?.className).toBe("sr-only");
      expect(dialog?.textContent).toContain("Comment");
      expect(dialog?.textContent).toContain("Approve");
      expect(dialog?.textContent).toContain("Request changes");

      const modalBody =
        dialog?.querySelector<HTMLElement>(".liquid-modal-body");
      const reviewModalBody = dialog?.querySelector<HTMLElement>(
        '[data-testid="pr-review-modal-body"]'
      );
      const decisionRow = dialog?.querySelector<HTMLElement>(
        '[data-testid="pr-review-decision-row"]'
      );
      const commentRow = dialog?.querySelector<HTMLElement>(
        '[data-testid="pr-review-comment-row"]'
      );
      expect(modalBody?.className).toContain("p-0");
      expect(reviewModalBody?.className).toContain("px-5");
      expect(reviewModalBody?.className).toContain("py-4");
      expect(decisionRow?.className).not.toContain("grid-cols-");
      expect(commentRow?.className).toContain("block");
      expect(commentRow?.textContent).toContain("Review comment");
      expect(commentRow?.querySelector("span")?.className).toBe("sr-only");

      const submitButton = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []
      ).find((button) => button.textContent?.trim() === "Submit review");
      expect(submitButton?.disabled).toBe(true);
      expect(submitButton?.style.height).toBe("28px");
      expect(submitButton?.parentElement?.className).toContain("border-t");

      await act(async () => {
        dialog
          ?.querySelector<HTMLInputElement>('input[value="REQUEST_CHANGES"]')
          ?.click();
      });

      const reviewComment = dialog?.querySelector<HTMLTextAreaElement>(
        '[data-testid="pr-review-comment"]'
      );
      expect(reviewComment?.style.resize).toBe("none");
      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        valueSetter?.call(reviewComment, "Please update the error handling.");
        reviewComment?.dispatchEvent(new Event("input", { bubbles: true }));
      });

      expect(submitButton?.disabled).toBe(false);
      await act(async () => {
        submitButton?.click();
        await Promise.resolve();
      });

      expect(onSubmitReview).toHaveBeenCalledWith(
        "REQUEST_CHANGES",
        "Please update the error handling."
      );
      expect(onDraftChange).not.toHaveBeenCalled();
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("restores a controlled conversation draft", () => {
    const markup = renderToStaticMarkup(
      createElement(PrConversationTab, {
        detail: null,
        identity: {
          number: 42,
          title: "Preserve the draft",
          url: "https://github.com/org/repo/pull/42",
          status: "open",
          headBranch: "feature/comments",
        },
        conversation: [],
        reviews: [],
        reviewComments: [],
        loading: false,
        submittingComment: false,
        submittingReview: false,
        draft: "Do not lose this review",
        onDraftChange: vi.fn(),
        onAddComment: vi.fn().mockResolvedValue(undefined),
        onSubmitReview: vi.fn().mockResolvedValue(undefined),
      })
    );
    const container = document.createElement("div");
    container.innerHTML = markup;

    expect(
      container
        .querySelector('[data-testid="pr-comment-editor"]')
        ?.getAttribute("data-value")
    ).toBe("Do not lose this review");
  });
});
