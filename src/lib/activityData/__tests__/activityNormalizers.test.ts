import { vi } from "vitest";

import {
  normalizeActivity,
  normalizeFunctionName,
} from "../activityNormalizers";

vi.mock("@src/engines/SessionCore/rendering/registry/toolAliases", () => ({
  resolveToolName: (name: string) => name,
}));

describe("normalizeActionType (via normalizeActivity)", () => {
  it("maps known types", () => {
    expect(normalizeActivity({ action_type: "tool_call" }).actionType).toBe(
      "tool_call"
    );
    expect(normalizeActivity({ action_type: "raw_event" }).actionType).toBe(
      "tool_call"
    );
    expect(normalizeActivity({ action_type: "Thinking" }).actionType).toBe(
      "thinking"
    );
  });

  it("lowercases unknown types", () => {
    expect(normalizeActivity({ action_type: "CUSTOM_TYPE" }).actionType).toBe(
      "custom_type"
    );
  });
});

describe("normalizeFunctionName", () => {
  it("maps known function names to ui_canonical", () => {
    expect(normalizeFunctionName("Read")).toBe("read_file");
    expect(normalizeFunctionName("Write")).toBe("edit_file");
    expect(normalizeFunctionName("Edit")).toBe("edit_file");
    expect(normalizeFunctionName("Bash")).toBe("run_shell");
    expect(normalizeFunctionName("Grep")).toBe("code_search");
    expect(normalizeFunctionName("Search")).toBe("code_search");
    expect(normalizeFunctionName("Task")).toBe("subagent");
    expect(normalizeFunctionName("spawn_agent")).toBe("subagent");
  });

  it("passes through unknown names", () => {
    expect(normalizeFunctionName("custom_func")).toBe("custom_func");
  });
});

describe("normalizeActivity", () => {
  it("returns defaults for null and undefined", () => {
    expect(normalizeActivity(null as never)).toMatchObject({
      functionName: "",
      actionType: "unknown",
    });
    expect(normalizeActivity(undefined as never)).toMatchObject({
      functionName: "",
    });
  });

  it("normalizes a basic event", () => {
    const normalized = normalizeActivity({
      function: "Read",
      args: { file_path: "test.ts" },
      result: { success: true },
    });
    expect(normalized.functionName).toBe("read_file");
    expect(normalized.result.success).toBe(true);
  });

  it("unwraps activityData", () => {
    const normalized = normalizeActivity({
      activityData: {
        function: "Read",
        args: { file_path: "x.ts" },
        result: { success: true },
      },
    });
    expect(normalized.functionName).toBe("read_file");
    expect(normalized.args.file_path).toBe("x.ts");
  });
});
