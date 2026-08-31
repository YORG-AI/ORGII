import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TranscriptItem } from "../../lib/transcriptReducer";
import {
  MobileToolCall,
  mobileToolSummary,
  normalizeMobileToolLifecycle,
} from "./MobileToolCall";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("MobileToolCall", () => {
  it("renders a compact dialog trigger without inserting details into the transcript", () => {
    const item: TranscriptItem = {
      id: "shell-1",
      kind: "tool",
      text: "run_shell",
      toolName: "run_shell",
      toolCanonical: "run_shell",
      toolStatus: "completed",
      toolSummary: "pnpm test",
      toolData: {
        kind: "shell",
        command: "pnpm test",
        output: "90 tests passed",
        exitCode: 0,
        isFailure: false,
      },
      toolDataTruncated: true,
    };

    const html = renderToStaticMarkup(
      React.createElement(MobileToolCall, {
        item,
        onOpenDetails: vi.fn(),
      })
    );

    expect(html).toContain('data-tool-call-name="run_shell"');
    expect(html).toContain('data-tool-call-layout="inline"');
    expect(html).toContain('data-tool-call-status="done"');
    expect(html).toContain("transcript.tools.labels.runCommand");
    expect(html).toContain("pnpm test");
    expect(html).toContain("chat-block-title");
    expect(html).toContain("chat-code-sm");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-tool-call-action="open-details"');
    expect(html).not.toContain("90 tests passed");
    expect(html).not.toContain("transcript.tools.truncated");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("rounded-lg");
    expect(html).not.toContain("bg-bg-2");
  });

  it("keeps the concrete file path visible while collapsed", () => {
    const item: TranscriptItem = {
      id: "file-1",
      kind: "tool",
      text: "read_file",
      toolName: "read_file",
      toolStatus: "running",
      toolData: {
        kind: "file",
        filePath: "src/modules/MobileRemote/MobileRemoteApp.tsx",
        fileName: "MobileRemoteApp.tsx",
        language: "typescript",
        lineCount: 120,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(MobileToolCall, { item })
    );

    expect(html).toContain("src/modules/MobileRemote/MobileRemoteApp.tsx");
    expect(html).toContain("transcript.tools.status.running");
    expect(mobileToolSummary(item)).toBe(
      "src/modules/MobileRemote/MobileRemoteApp.tsx"
    );
  });

  it("maps failed and waiting states without relying on color alone", () => {
    expect(normalizeMobileToolLifecycle("failed")).toBe("failed");
    expect(normalizeMobileToolLifecycle("waiting_for_user")).toBe("running");
    expect(normalizeMobileToolLifecycle("completed")).toBe("done");
  });
});
