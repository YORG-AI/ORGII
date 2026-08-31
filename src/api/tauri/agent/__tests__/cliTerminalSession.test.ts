import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CliLaunchProfileView } from "@src/api/tauri/rpc/schemas/agentOrgs";

import {
  appendCliCommandArgs,
  deriveExpectedProcess,
  formatCliTuiCommand,
  resolveCliTuiCommand,
} from "../cliTerminalSession";

const { getLaunchProfile } = vi.hoisted(() => ({
  getLaunchProfile: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    agentOrgs: {
      launchProfiles: {
        get: getLaunchProfile,
      },
    },
  },
}));

function profile(
  overrides: Partial<CliLaunchProfileView> = {}
): CliLaunchProfileView {
  return {
    agentName: "trae_cli",
    permissionMode: "manual",
    defaultCommand: "trae-cli",
    command: "trae-cli",
    args: [],
    env: {},
    manualArgs: [],
    fullPermissionArgs: [],
    manualEnv: {},
    fullPermissionEnv: {},
    supportedPermissionModes: ["manual"],
    modeDefaults: [],
    commandOverridden: false,
    argsOverridden: false,
    envOverridden: false,
    effectiveCommand: ["trae-cli", "interactive"],
    requiredArgs: ["interactive"],
    ...overrides,
  };
}

describe("formatCliTuiCommand", () => {
  it("adds required interactive arguments to the detected executable", () => {
    expect(
      formatCliTuiCommand(profile(), "/opt/trae/bin/trae-cli", false)
    ).toBe("/opt/trae/bin/trae-cli interactive");
  });

  it("omits Codex's prompt-required exec subcommand for interactive TUI launches", () => {
    expect(
      formatCliTuiCommand(
        profile({
          agentName: "codex",
          defaultCommand: "codex",
          command: "codex",
          requiredArgs: ["exec"],
          args: ["--dangerously-bypass-approvals-and-sandbox"],
        }),
        "codex",
        false
      )
    ).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  it("honors command and argument overrides with POSIX shell-safe quoting", () => {
    expect(
      formatCliTuiCommand(
        profile({
          commandOverridden: true,
          command: "/Applications/Trae Agent/trae-cli",
          requiredArgs: [],
          args: ["interactive", "two words"],
        }),
        "trae-cli",
        false
      )
    ).toBe("'/Applications/Trae Agent/trae-cli' interactive 'two words'");
  });

  it("quotes a backslash-heavy Windows path for PowerShell instead of POSIX-escaping it", () => {
    expect(
      formatCliTuiCommand(
        profile({
          commandOverridden: true,
          command: "C:\\Users\\me\\Trae Agent\\trae-cli.exe",
          requiredArgs: [],
          args: ["interactive"],
        }),
        "trae-cli",
        true
      )
    ).toBe("'C:\\Users\\me\\Trae Agent\\trae-cli.exe' interactive");
  });

  it("doubles embedded single quotes for PowerShell instead of POSIX '\\'' escaping", () => {
    expect(
      formatCliTuiCommand(
        profile({
          commandOverridden: true,
          command: "trae-cli",
          requiredArgs: [],
          args: ["a 'quoted' word"],
        }),
        "trae-cli",
        true
      )
    ).toBe("trae-cli 'a ''quoted'' word'");
  });

  it("passes safe-charset arguments through unquoted on both platforms", () => {
    const withOverride = profile({
      commandOverridden: true,
      command: "/opt/trae/bin/trae-cli",
      requiredArgs: [],
      args: ["interactive"],
    });
    expect(formatCliTuiCommand(withOverride, "trae-cli", false)).toBe(
      "/opt/trae/bin/trae-cli interactive"
    );
    expect(formatCliTuiCommand(withOverride, "trae-cli", true)).toBe(
      "/opt/trae/bin/trae-cli interactive"
    );
  });
});

describe("appendCliCommandArgs", () => {
  it("appends resume arguments after the resolved profile command", () => {
    expect(
      appendCliCommandArgs(
        "claude --permission-mode plan",
        ["--resume", "b52f4220-8b0b-46c5-8ee6-001ebf91c6ed"],
        false
      )
    ).toBe(
      "claude --permission-mode plan --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed"
    );
  });

  it("quotes unsafe arguments POSIX-style and drops blank ones", () => {
    expect(
      appendCliCommandArgs("codex", ["resume", " ", "two words"], false)
    ).toBe("codex resume 'two words'");
    expect(appendCliCommandArgs("codex", [], false)).toBe("codex");
  });

  it("quotes a Windows session-file path for PowerShell (backslashes pass through literally)", () => {
    expect(
      appendCliCommandArgs(
        "omp",
        ["--session", "C:\\Users\\me\\.omp\\agent\\sessions\\session.jsonl"],
        true
      )
    ).toBe(
      "omp --session 'C:\\Users\\me\\.omp\\agent\\sessions\\session.jsonl'"
    );
  });

  it("keeps a safe-charset resume id unquoted for PowerShell", () => {
    expect(
      appendCliCommandArgs(
        "claude",
        ["--resume", "b52f4220-8b0b-46c5-8ee6-001ebf91c6ed"],
        true
      )
    ).toBe("claude --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed");
  });
});

describe("resolveCliTuiCommand", () => {
  beforeEach(() => {
    getLaunchProfile.mockReset();
  });

  it("falls back to the detected command when the launch-profile RPC rejects", async () => {
    getLaunchProfile.mockRejectedValueOnce(new Error("IPC unavailable"));

    await expect(
      resolveCliTuiCommand("claude_code", "/opt/claude/bin/claude")
    ).resolves.toBe("/opt/claude/bin/claude");
    expect(getLaunchProfile).toHaveBeenCalledWith({ agentName: "claude_code" });
  });

  it("formats the resolved command from a successful profile fetch", async () => {
    getLaunchProfile.mockResolvedValueOnce(
      profile({ requiredArgs: [], args: ["--dangerously-skip-permissions"] })
    );

    await expect(
      resolveCliTuiCommand("trae_cli", "/opt/trae/bin/trae-cli")
    ).resolves.toBe("/opt/trae/bin/trae-cli --dangerously-skip-permissions");
  });
});

describe("deriveExpectedProcess", () => {
  it("returns the first whitespace-delimited token for a plain binary", () => {
    expect(deriveExpectedProcess("claude --resume abc123")).toBe("claude");
  });

  it("unwraps a POSIX-quoted binary containing spaces instead of splitting mid-path", () => {
    expect(
      deriveExpectedProcess("'/Applications/Trae Agent/trae-cli' interactive")
    ).toBe("/Applications/Trae Agent/trae-cli");
  });

  it("unwraps a PowerShell-quoted binary containing spaces", () => {
    expect(
      deriveExpectedProcess(
        "'C:\\Program Files\\Trae\\trae-cli.exe' interactive"
      )
    ).toBe("C:\\Program Files\\Trae\\trae-cli.exe");
  });

  it("returns undefined for a blank command", () => {
    expect(deriveExpectedProcess("   ")).toBeUndefined();
  });
});
