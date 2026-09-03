import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getToolIconComponent } from "@src/config/toolIcons";
import { _resetToolRegistry } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { BookOpen02Icon, Search01Icon, Wrench01Icon } from "@src/icons";

import type { TranscriptItem } from "../../lib/transcriptReducer";
import {
  MobileToolCall,
  mobileToolSummary,
  normalizeMobileToolLifecycle,
  resolveMobileToolIconName,
} from "./MobileToolCall";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  _resetToolRegistry();
});

describe("resolveMobileToolIconName", () => {
  it("prefers ui canonical over generic function names", () => {
    const item: TranscriptItem = {
      id: "tool-1",
      kind: "tool",
      text: "tool_call",
      toolName: "tool_call",
      toolCanonical: "read_file",
      toolData: {
        kind: "file",
        filePath: "src/a.ts",
        fileName: "a.ts",
        language: "typescript",
      },
    };
    expect(resolveMobileToolIconName(item)).toBe("read_file");
  });

  it("falls back to structured tool kind when names are generic", () => {
    const item: TranscriptItem = {
      id: "tool-2",
      kind: "tool",
      text: "tool",
      toolName: "tool_call",
      toolData: {
        kind: "search",
        query: "merge_events",
        results: [],
        totalMatches: 0,
      },
    };
    expect(resolveMobileToolIconName(item)).toBe("code_search");
  });
});

describe("MobileToolCall", () => {
  it("renders distinct icons per tool without the desktop tool registry", () => {
    const readItem: TranscriptItem = {
      id: "file-1",
      kind: "tool",
      text: "tool_call",
      toolName: "tool_call",
      toolData: {
        kind: "file",
        filePath: "src/a.ts",
        fileName: "a.ts",
        language: "typescript",
      },
    };
    const searchItem: TranscriptItem = {
      id: "search-1",
      kind: "tool",
      text: "tool_call",
      toolName: "tool_call",
      toolData: {
        kind: "search",
        query: "merge_events",
        results: [],
        totalMatches: 0,
      },
    };

    expect(getToolIconComponent(resolveMobileToolIconName(readItem))).toBe(
      BookOpen02Icon
    );
    expect(getToolIconComponent(resolveMobileToolIconName(searchItem))).toBe(
      Search01Icon
    );
    expect(getToolIconComponent("tool")).toBe(Wrench01Icon);

    const readHtml = renderToStaticMarkup(
      React.createElement(MobileToolCall, { item: readItem })
    );
    const searchHtml = renderToStaticMarkup(
      React.createElement(MobileToolCall, { item: searchItem })
    );
    expect(readHtml).not.toEqual(searchHtml);
  });

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
    expect(html).toContain("chat-block-header");
    expect(html).toContain("chat-block-icon");
    expect(html).not.toContain("chat-code-sm");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-tool-call-action="open-details"');
    expect(html).not.toContain("90 tests passed");
    expect(html).not.toContain("transcript.tools.truncated");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
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

  it("keeps status labels in a fixed trailing column", () => {
    const shortSummaryItem: TranscriptItem = {
      id: "search-short",
      kind: "tool",
      text: "tool_call",
      toolName: "tool_call",
      toolStatus: "completed",
      toolData: {
        kind: "search",
        query: "would_downgrade_terminal",
        results: [],
        totalMatches: 0,
      },
    };
    const longSummaryItem: TranscriptItem = {
      id: "file-long",
      kind: "tool",
      text: "read_file",
      toolName: "read_file",
      toolStatus: "completed",
      toolData: {
        kind: "file",
        filePath: "src/modules/MobileRemote/MobileRemoteApp.tsx",
        fileName: "MobileRemoteApp.tsx",
        language: "typescript",
      },
    };

    const shortHtml = renderToStaticMarkup(
      React.createElement(MobileToolCall, { item: shortSummaryItem })
    );
    const longHtml = renderToStaticMarkup(
      React.createElement(MobileToolCall, { item: longSummaryItem })
    );

    expect(shortHtml).toContain('data-mobile-tool-status-trailing="true"');
    expect(longHtml).toContain('data-mobile-tool-status-trailing="true"');
    expect(shortHtml).toMatch(
      /data-mobile-tool-status-trailing="true"[\s\S]*transcript\.tools\.status\.done/
    );
    const leftSection = shortHtml.match(
      /<div class="flex min-w-0 flex-1 items-center gap-2 leading-tight">([\s\S]*?)<\/div><div class="flex shrink-0 items-center gap-1 select-none">/
    )?.[1];
    expect(leftSection).toContain("&quot;would_downgrade_terminal&quot;");
    expect(leftSection).not.toContain("transcript.tools.status.done");
  });

  it("formats grep alternation queries as readable comma-separated subtitles", () => {
    const item: TranscriptItem = {
      id: "search-alt",
      kind: "tool",
      text: "tool_call",
      toolName: "tool_call",
      toolStatus: "completed",
      toolData: {
        kind: "search",
        query: "call_id_index|tool_result|merge_events",
        results: [],
        totalMatches: 0,
      },
    };

    expect(mobileToolSummary(item)).toBe(
      '"call_id_index, tool_result, merge_events"'
    );
  });

  it("maps failed and waiting states without relying on color alone", () => {
    expect(normalizeMobileToolLifecycle("failed")).toBe("failed");
    expect(normalizeMobileToolLifecycle("waiting_for_user")).toBe("running");
    expect(normalizeMobileToolLifecycle("completed")).toBe("done");
  });
});
