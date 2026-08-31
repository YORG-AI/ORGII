import { describe, expect, it } from "vitest";

import {
  buildPermissionArgsPreview,
  resolvePermissionPromptViewModel,
} from "./permissionPromptHelpers";

describe("buildPermissionArgsPreview", () => {
  it("truncates long string values", () => {
    const preview = buildPermissionArgsPreview({
      command: "x".repeat(200),
    });
    expect(preview[0]?.value).toHaveLength(120 + 3);
    expect(preview[0]?.value.endsWith("...")).toBe(true);
  });

  it("limits to five args", () => {
    const args = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`k${index}`, index])
    );
    expect(buildPermissionArgsPreview(args)).toHaveLength(5);
  });

  it("serializes non-string values as JSON", () => {
    const preview = buildPermissionArgsPreview({ nested: { ok: true } });
    expect(preview[0]?.value).toBe('{"ok":true}');
  });
});

describe("resolvePermissionPromptViewModel", () => {
  it("maps command confirm tools to commandText", () => {
    const model = resolvePermissionPromptViewModel({
      tool: "exec:command-confirm",
      args: { command: "pnpm test", reason: "Needs approval" },
      permissionPromptLabel: "Permission",
      commandConfirmTitle: "Command Requires Approval",
    });
    expect(model.label).toBe("Command Requires Approval");
    expect(model.commandText).toBe("pnpm test");
    expect(model.description).toBe("Needs approval");
    expect(model.argsPreview).toEqual([]);
  });

  it("maps standard tools to args preview", () => {
    const model = resolvePermissionPromptViewModel({
      tool: "run_shell",
      args: { command: "git status" },
      permissionPromptLabel: "Your permission is needed",
      commandConfirmTitle: "Command Requires Approval",
    });
    expect(model.label).toBe("Your permission is needed");
    expect(model.commandText).toBeNull();
    expect(model.argsPreview).toEqual([
      { key: "command", value: "git status" },
    ]);
  });
});
