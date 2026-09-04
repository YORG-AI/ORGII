import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RecipeRendererProps } from "../RecipeRenderer";
import { RecipeRenderer } from "../RecipeRenderer";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

function renderWorktreeEvent(
  args: Record<string, unknown>,
  result: Record<string, unknown>
) {
  return renderFlatWorktreeEvent(args, result);
}

function renderFlatWorktreeEvent(
  args: Record<string, unknown>,
  result: Record<string, unknown>
) {
  const props: RecipeRendererProps = {
    event_id: "event-worktree-flat",
    functionName: "worktree",
    uiCanonical: "worktree",
    action_type: "tool_call",
    args,
    result,
    status: result.error ? "failed" : "completed",
  };

  return renderToStaticMarkup(createElement(RecipeRenderer, props));
}

describe("FallbackAdapter worktree block routing", () => {
  it("renders worktree add as a structured block, collapsed by default", () => {
    const markup = renderWorktreeEvent(
      { action: "add", base_ref: "develop", branch: "fix/issue-148" },
      {
        content:
          "Created worktree at `/repo/.orgii/worktrees/fix/issue-148`\nBranch: `fix/issue-148`\nBase: `develop`",
      }
    );

    expect(markup).toContain('data-tool-call-name="worktree"');
    // Detail rows (branch/base/path) only render after the user expands.
    expect(markup).not.toContain("fix/issue-148");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("keeps output JSON detail rows collapsed by default", () => {
    const markup = renderFlatWorktreeEvent(
      { action: "add", branch: "fix/output-json" },
      {
        output: JSON.stringify({
          success: true,
          branch: "fix/output-json",
          path: "/repo/.orgii/worktrees/fix/output-json",
          base: "HEAD",
          content:
            "Created worktree at `/repo/.orgii/worktrees/fix/output-json`\nBranch: `fix/output-json`\nBase: `HEAD`",
        }),
      }
    );

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).not.toContain("/repo/.orgii/worktrees/fix/output-json");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("shows the list entry count in the header while entries stay collapsed", () => {
    const markup = renderFlatWorktreeEvent(
      { action: "list" },
      {
        output: JSON.stringify({
          success: true,
          entries: [{ path: "/repo/.orgii/worktrees/a", branch: "a" }],
          content:
            "**Worktrees (1):**\n- `/repo/.orgii/worktrees/a` (branch: a)",
        }),
      }
    );

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).toContain(">1<");
    expect(markup).not.toContain("/repo/.orgii/worktrees/a");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("renders worktree leave as a structured block, collapsed by default", () => {
    const markup = renderWorktreeEvent(
      { action: "leave", remove: false },
      {
        content:
          "Left worktree `/repo/.orgii/worktrees/fix/issue-148`\nReturned to `/repo`",
      }
    );

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).toContain("leave");
    expect(markup).not.toContain("Returned to `/repo`");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("keeps empty worktree list on the dedicated block", () => {
    const markup = renderWorktreeEvent({ action: "list" }, { entries: [] });

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("routes flat tool_call events by uiCanonical", () => {
    const props: RecipeRendererProps = {
      event_id: "event-worktree-ui-canonical",
      functionName: "tool_call",
      uiCanonical: "worktree",
      action_type: "tool_call",
      args: { action: "add", base_ref: "develop", branch: "fix/issue-137" },
      result: {
        error:
          "Error executing worktree: Execution failed: git worktree add failed: fatal: 'fix/issue-137' is already used by worktree",
      },
      status: "failed",
    };

    const markup = renderToStaticMarkup(createElement(RecipeRenderer, props));

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).not.toContain("already used by worktree");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });

  it("renders failed worktree mutations as a structured block, collapsed by default", () => {
    const markup = renderWorktreeEvent(
      { action: "add", base_ref: "develop", branch: "fix/issue-148" },
      { error: "Already in a worktree" }
    );

    expect(markup).toContain('data-tool-call-name="worktree"');
    expect(markup).not.toContain("Already in a worktree");
    expect(markup).not.toContain("INPUT");
    expect(markup).not.toContain("OUTPUT");
  });
});
