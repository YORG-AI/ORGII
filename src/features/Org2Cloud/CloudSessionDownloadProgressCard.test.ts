import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CloudSessionDownloadProgressCard from "./CloudSessionDownloadProgressCard";
import {
  type CloudSessionDownloadProgress,
  cloudSessionDownloadProgressAtom,
} from "./cloudSessionDownloadProgressAtom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { eta?: string; loaded?: number; total?: number }
    ) => {
      if (key === "cloud.download.events") {
        return `${options?.loaded} / ${options?.total} events`;
      }
      if (key === "cloud.download.eta") {
        return `About ${options?.eta} remaining`;
      }
      return key;
    },
  }),
}));

function renderProgress(
  overrides: Partial<CloudSessionDownloadProgress> = {}
): string {
  const store = createStore();
  store.set(
    cloudSessionDownloadProgressAtom,
    new Map([
      [
        "session-1",
        {
          rowId: "row-1",
          orgId: "org-1",
          loadedEvents: 138,
          totalEvents: 252,
          startedAtMs: 1_000,
          updatedAtMs: 11_000,
          phase: "downloading",
          ...overrides,
        },
      ],
    ])
  );

  return renderToStaticMarkup(
    createElement(
      Provider,
      { store },
      createElement(CloudSessionDownloadProgressCard, {
        sessionId: "session-1",
      })
    )
  );
}

describe("CloudSessionDownloadProgressCard", () => {
  it("renders a content-width progress bar above a centered floating pill", () => {
    const markup = renderProgress();

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="54"');
    expect(markup).toContain("h-0.5");
    expect(markup).toContain("!rounded-none");
    expect(markup).toContain("absolute inset-x-0 -top-2");
    expect(markup).toContain("items-center justify-center");
    expect(markup).not.toContain("items-center justify-end");
    expect(markup).not.toContain("relative mx-1 mb-2");
    expect(markup).toContain(
      'data-testid="cloud-session-download-progress-pill"'
    );
    expect(markup).toContain("max-w-[75%]");
    expect(markup).not.toContain("absolute inset-x-0 top-2");
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("54%");
    expect(markup).toContain("138 / 252 events");
    expect(markup).toContain("About 8s remaining");
  });

  it("keeps paused progress and its resume action inside the pill", () => {
    const markup = renderProgress({ phase: "paused" });

    expect(markup).toContain("cloud.download.paused");
    expect(markup).toContain('data-testid="cloud-session-download-resume"');
    expect(markup).not.toContain("About 8s remaining");
  });

  it("keeps an indeterminate download label visible when no numbers exist", () => {
    const markup = renderProgress({ loadedEvents: 0, totalEvents: null });

    expect(markup).toContain("progress-bar--indeterminate");
    expect(markup).toContain("cloud.download.title");
  });
});
