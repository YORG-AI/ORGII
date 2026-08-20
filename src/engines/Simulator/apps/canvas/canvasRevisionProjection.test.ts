import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { projectLatestCanvasEvents } from "./canvasRevisionProjection";

function canvasEvent(
  id: string,
  options: {
    sessionId?: string;
    revises?: string;
    content?: string;
    status?: "completed" | "failed";
    legacyRevision?: boolean;
    edits?: Array<{ find: string; replace: string; all?: boolean }>;
  } = {}
): SessionEvent {
  return {
    id,
    sessionId: options.sessionId ?? "session-a",
    functionName: options.revises
      ? options.legacyRevision
        ? "render_inline_canvas"
        : "revise_inline_canvas"
      : "render_inline_canvas",
    displayStatus: options.status ?? "completed",
    args: {
      mode: "react",
      content: options.content ?? `content-${id}`,
      ...(options.edits ? { content: undefined, edits: options.edits } : {}),
      ...(options.revises
        ? options.legacyRevision
          ? { revises_event_id: options.revises }
          : { target_event_id: options.revises }
        : {}),
    },
  } as unknown as SessionEvent;
}

describe("Canvas revision projection", () => {
  it("keeps unrelated Canvas events as separate logical entries", () => {
    const first = canvasEvent("first");
    const second = canvasEvent("second");

    expect(projectLatestCanvasEvents([first, second])).toEqual([first, second]);
  });

  it("replaces the original logical Canvas with its latest revision", () => {
    const original = canvasEvent("original");
    const unrelated = canvasEvent("unrelated");
    const revision = canvasEvent("revision", {
      revises: "original",
      content: "updated-content",
    });

    expect(projectLatestCanvasEvents([original, unrelated, revision])).toEqual([
      revision,
      unrelated,
    ]);
  });

  it("collapses a multi-step revision chain to its newest event", () => {
    const original = canvasEvent("original");
    const revision = canvasEvent("revision", { revises: "original" });
    const latest = canvasEvent("latest", { revises: "revision" });

    expect(projectLatestCanvasEvents([original, revision, latest])).toEqual([
      latest,
    ]);
  });

  it("materializes compact text edits across a revision chain", () => {
    const original = canvasEvent("original", {
      content: "<button>Start</button><p>Keep me</p>",
    });
    const firstPatch = canvasEvent("first-patch", {
      revises: "original",
      edits: [{ find: "Start", replace: "Start setup" }],
    });
    const secondPatch = canvasEvent("second-patch", {
      revises: "first-patch",
      edits: [{ find: "Keep me", replace: "Still here" }],
    });

    const [latest] = projectLatestCanvasEvents([
      original,
      firstPatch,
      secondPatch,
    ]);

    expect(latest.id).toBe("second-patch");
    expect(latest.args.content).toBe(
      "<button>Start setup</button><p>Still here</p>"
    );
  });

  it("keeps the last valid Canvas when a compact edit is stale or ambiguous", () => {
    const original = canvasEvent("original", {
      content: "<span>Same</span><span>Same</span>",
    });
    const ambiguous = canvasEvent("ambiguous", {
      revises: "original",
      edits: [{ find: "Same", replace: "Changed" }],
    });

    expect(projectLatestCanvasEvents([original, ambiguous])).toEqual([
      original,
    ]);
  });

  it("supports deliberate replace-all edits", () => {
    const original = canvasEvent("original", {
      content: "small small",
    });
    const revision = canvasEvent("revision", {
      revises: "original",
      edits: [{ find: "small", replace: "large", all: true }],
    });

    const [latest] = projectLatestCanvasEvents([original, revision]);
    expect(latest.args.content).toBe("large large");
  });

  it("ignores malformed dedicated revisions instead of creating new Canvases", () => {
    const missing = canvasEvent("missing", { revises: "not-present" });
    const futureRevision = canvasEvent("future-revision", {
      revises: "future-target",
    });
    const futureTarget = canvasEvent("future-target");
    const otherSession = canvasEvent("other-session", {
      sessionId: "session-b",
      revises: "future-target",
    });

    expect(
      projectLatestCanvasEvents([
        missing,
        futureRevision,
        futureTarget,
        otherSession,
      ])
    ).toEqual([futureTarget]);
  });

  it("keeps the last valid Canvas when a revision fails", () => {
    const original = canvasEvent("original");
    const failed = canvasEvent("failed-revision", {
      revises: "original",
      status: "failed",
    });

    expect(projectLatestCanvasEvents([original, failed])).toEqual([original]);
  });

  it("still projects persisted legacy revision chains", () => {
    const original = canvasEvent("original");
    const legacyRevision = canvasEvent("legacy-revision", {
      revises: "original",
      legacyRevision: true,
    });

    expect(projectLatestCanvasEvents([original, legacyRevision])).toEqual([
      legacyRevision,
    ]);
  });

  it("keeps malformed legacy metadata visible as a separate historical Canvas", () => {
    const legacy = canvasEvent("legacy", {
      revises: "missing",
      legacyRevision: true,
    });

    expect(projectLatestCanvasEvents([legacy])).toEqual([legacy]);
  });
});
