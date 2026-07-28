/**
 * Shell-search converter tests: grep/rg pipelines run via run_shell become
 * ExploreOperationEntry rows; ordinary commands stay terminal.
 */
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { ShellOperationEntry } from "../../types";
import {
  convertShellSearchOperation,
  isShellSearchEvent,
} from "../shellSearchConverter";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "shell-evt-1",
    sessionId: "sess-1",
    createdAt: "2026-07-25T12:00:00.000Z",
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

function makeShellOp(
  command: string,
  overrides: Partial<ShellOperationEntry> = {}
): ShellOperationEntry {
  return {
    command,
    shortCommand: command,
    commandKeywords: "",
    event: minimalSessionEvent({ args: { command } }),
    eventId: "shell-evt-1",
    isCurrent: false,
    ...overrides,
  };
}

describe("convertShellSearchOperation", () => {
  it("returns null for ordinary shell commands", () => {
    expect(
      convertShellSearchOperation(makeShellOp("npm run build"))
    ).toBeNull();
    expect(
      convertShellSearchOperation(makeShellOp("cd src && grep -rn foo ."))
    ).toBeNull();
  });

  it("converts a grep pipeline with path:line:content output", () => {
    const op = convertShellSearchOperation(
      makeShellOp('grep -rn "useAtomValue" src | head -20', {
        output: [
          "src/a.ts:10:const x = useAtomValue(fooAtom);",
          "src/b.tsx:42:  useAtomValue(barAtom)",
        ].join("\n"),
      })
    );

    expect(op).not.toBeNull();
    expect(op?.exploreType).toBe("code_search");
    expect(op?.exploreAction).toBe("grep");
    expect(op?.query).toBe("useAtomValue");
    expect(op?.directory).toBe("src");
    expect(op?.results).toEqual([
      {
        file: "src/a.ts",
        line: 10,
        content: "const x = useAtomValue(fooAtom);",
      },
      { file: "src/b.tsx", line: 42, content: "  useAtomValue(barAtom)" },
    ]);
    expect(op?.totalMatches).toBe(2);
    expect(op?.hasResultPayload).toBe(true);
  });

  it("converts grep -l output into a file list", () => {
    const op = convertShellSearchOperation(
      makeShellOp('grep -rl "SearchBlock" src --include=*.tsx | head', {
        output: ["src/blocks/SearchBlock/index.tsx", "src/adapters/a.tsx"].join(
          "\n"
        ),
      })
    );

    expect(op?.results).toEqual([]);
    expect(op?.files).toEqual([
      "src/blocks/SearchBlock/index.tsx",
      "src/adapters/a.tsx",
    ]);
    expect(op?.totalMatches).toBe(2);
  });

  it("keeps loading/failed flags and slims the event payload", () => {
    const op = convertShellSearchOperation(
      makeShellOp('grep -rn "foo" src', {
        isLoading: true,
        isFailed: false,
        isCurrent: true,
      })
    );

    expect(op?.isLoading).toBe(true);
    expect(op?.isCurrent).toBe(true);
    expect(op?.hasResultPayload).toBe(false);
    expect(op?.totalMatches).toBe(0);
    expect(op?.event.args).toEqual({});
    expect(op?.event.result).toEqual({});
  });
});

describe("isShellSearchEvent", () => {
  it("reads the command from event.command or args.command", () => {
    expect(
      isShellSearchEvent(minimalSessionEvent({ command: "grep -rn foo src" }))
    ).toBe(true);
    expect(
      isShellSearchEvent(
        minimalSessionEvent({ args: { command: "rg -n foo src | head" } })
      )
    ).toBe(true);
    expect(
      isShellSearchEvent(minimalSessionEvent({ args: { command: "ls -la" } }))
    ).toBe(false);
    expect(isShellSearchEvent(null)).toBe(false);
  });
});
