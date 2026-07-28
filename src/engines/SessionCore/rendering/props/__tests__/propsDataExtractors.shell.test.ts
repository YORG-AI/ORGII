import { describe, expect, it } from "vitest";

import { extractShellData } from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// extractShellData
// ============================================

describe("extractShellData", () => {
  describe("command extraction", () => {
    it("extracts command from successData", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "npm test" } },
        },
      });
      expect(extractShellData(props).command).toBe("npm test");
    });

    it("extracts command from args.command as fallback", () => {
      const props = makeUniversalProps({
        args: { command: "npm install" },
      });
      expect(extractShellData(props).command).toBe("npm install");
    });

    it("extracts command from result.command as last fallback", () => {
      const props = makeUniversalProps({
        result: { command: "git status" },
      });
      expect(extractShellData(props).command).toBe("git status");
    });

    it("returns empty string when no command found", () => {
      const props = makeUniversalProps({ args: {}, result: {} });
      expect(extractShellData(props).command).toBe("");
    });
  });

  describe("description extraction", () => {
    it("extracts description from args", () => {
      const props = makeUniversalProps({
        args: { command: "npm test", description: "Run unit tests" },
      });
      expect(extractShellData(props).description).toBe("Run unit tests");
    });

    it("returns undefined when no description", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      expect(extractShellData(props).description).toBeUndefined();
    });
  });

  describe("output priority", () => {
    it("interleavedOutput has highest priority", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              interleavedOutput: "interleaved",
              stdout: "stdout text",
              stderr: "stderr text",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("interleaved");
    });

    it("stdout is next priority after interleavedOutput", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              stdout: "stdout text",
              stderr: "stderr text",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("stdout text");
    });

    it("stderr is next fallback", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: {
              stderr: "error output",
              command: "cmd",
            },
          },
        },
      });
      expect(extractShellData(props).output).toBe("error output");
    });

    it("streamOutput from args is next fallback", () => {
      const props = makeUniversalProps({
        args: { command: "npm build", streamOutput: "Building..." },
      });
      expect(extractShellData(props).output).toBe("Building...");
    });

    it("result.output (via safeText) is next fallback", () => {
      const props = makeUniversalProps({
        args: { command: "echo hi" },
        result: { output: "direct output string" },
      });
      expect(extractShellData(props).output).toBe("direct output string");
    });

    it("result.observation is last fallback", () => {
      const props = makeUniversalProps({
        args: { command: "echo hi" },
        result: { observation: "observed output" },
      });
      expect(extractShellData(props).output).toBe("observed output");
    });

    it("returns undefined when no output source available", () => {
      const props = makeUniversalProps({
        args: { command: "noop" },
        result: {},
      });
      expect(extractShellData(props).output).toBeUndefined();
    });
  });

  describe("exitCode extraction", () => {
    it("extracts camelCase exitCode from success data", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exitCode: 0 } },
        },
      });
      expect(extractShellData(props).exitCode).toBe(0);
    });

    it("extracts snake_case exit_code from success data", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exit_code: 127 } },
        },
      });
      expect(extractShellData(props).exitCode).toBe(127);
    });

    it("extracts exit_code from result directly", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: { exit_code: 1 },
      });
      expect(extractShellData(props).exitCode).toBe(1);
    });

    it("returns undefined when no exit code", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: {},
      });
      expect(extractShellData(props).exitCode).toBeUndefined();
    });
  });

  describe("executionTime extraction", () => {
    it("extracts executionTime from success data (camelCase)", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: { command: "test", executionTime: 1234 },
          },
        },
      });
      expect(extractShellData(props).executionTime).toBe(1234);
    });

    it("extracts execution_time from success data (snake_case)", () => {
      const props = makeUniversalProps({
        result: {
          output: {
            success: { command: "test", execution_time: 5678 },
          },
        },
      });
      expect(extractShellData(props).executionTime).toBe(5678);
    });
  });

  describe("cwd extraction", () => {
    it("extracts cwd from args", () => {
      const props = makeUniversalProps({
        args: { command: "ls", cwd: "/project/src" },
      });
      expect(extractShellData(props).cwd).toBe("/project/src");
    });

    it("returns undefined when no cwd", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      expect(extractShellData(props).cwd).toBeUndefined();
    });
  });

  describe("isFailure flag", () => {
    it("isFailure is true when only failure data present (no success)", () => {
      const props = makeUniversalProps({
        args: { command: "bad-cmd" },
        result: {
          output: {
            failure: { error: "command not found", command: "bad-cmd" },
          },
        },
      });
      expect(extractShellData(props).isFailure).toBe(true);
    });

    it("isFailure is false when success data present", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", exitCode: 0 } },
        },
      });
      expect(extractShellData(props).isFailure).toBe(false);
    });

    it("isFailure is false when neither success nor failure present", () => {
      const props = makeUniversalProps({
        args: { command: "ls" },
        result: {},
      });
      expect(extractShellData(props).isFailure).toBe(false);
    });
  });

  describe("shell process state", () => {
    it("uses exact lifecycle exit code when result output was sanitized", () => {
      const props = makeUniversalProps({
        args: { command: "npm test", shellExitCode: 7 },
        result: {},
      });
      expect(extractShellData(props).exitCode).toBe(7);
    });

    it("top-level shell process state overrides stale Rust-extracted state", () => {
      const props = makeUniversalProps({
        rustExtracted: {
          kind: "shell",
          command: "npm start",
          isFailure: false,
          shellPid: 11111,
          shellProcessStatus: "running",
          shellLogPath: "/tmp/old-shell.log",
        },
        shellPid: 22222,
        shellProcessStatus: "background",
        shellLogPath: "/tmp/background-shell.log",
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(22222);
      expect(data.shellProcessStatus).toBe("background");
      expect(data.shellLogPath).toBe("/tmp/background-shell.log");
    });

    it("extracts shellPid, shellProcessStatus, shellLogPath from args", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm start",
          shellPid: 12345,
          shellProcessStatus: "running",
          shellLogPath: "/tmp/shell.log",
        },
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("running");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("extracts top-level normalized shell process state", () => {
      const props = makeUniversalProps({
        args: { command: "npm start" },
        shellPid: 12345,
        shellProcessStatus: "background",
        shellLogPath: "/tmp/shell.log",
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("background");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("extracts snake-case shell process state from args", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm start",
          shell_pid: 12345,
          shell_process_status: "running",
          shell_log_path: "/tmp/shell.log",
        },
      });
      const data = extractShellData(props);
      expect(data.shellPid).toBe(12345);
      expect(data.shellProcessStatus).toBe("running");
      expect(data.shellLogPath).toBe("/tmp/shell.log");
    });

    it("returns undefined for shell process state when not present", () => {
      const props = makeUniversalProps({ args: { command: "ls" } });
      const data = extractShellData(props);
      expect(data.shellPid).toBeUndefined();
      expect(data.shellProcessStatus).toBeUndefined();
      expect(data.shellLogPath).toBeUndefined();
    });
  });

  describe("streamOutput", () => {
    it("returns streamOutput separately from output", () => {
      const props = makeUniversalProps({
        args: {
          command: "npm build",
          streamOutput: "Compiling...",
        },
      });
      const data = extractShellData(props);
      expect(data.streamOutput).toBe("Compiling...");
      expect(data.output).toBe("Compiling...");
    });

    it("streamOutput is undefined when args.streamOutput is absent", () => {
      const props = makeUniversalProps({
        result: {
          output: { success: { command: "ls", stdout: "files" } },
        },
      });
      expect(extractShellData(props).streamOutput).toBeUndefined();
    });
  });
});
