// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import {
  RpcError,
  defineProcedure,
  getRpcOutputValidationMode,
  resetRpcOutputValidationMode,
  rpcCall,
  setRpcOutputValidationMode,
} from "../invoke";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const numberProc = defineProcedure("drift_probe")
  .output(z.object({ n: z.number() }))
  .build();

describe("typedInvoke output-validation modes", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetRpcOutputValidationMode();
    window.__orgiiRpcOutputDrift = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetRpcOutputValidationMode();
    vi.restoreAllMocks();
  });

  it("defaults to warn in dev/test: logs, records drift, returns raw data (no throw)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({ n: "not-a-number" });

    const result = await rpcCall(numberProc);

    // Data is still returned so a schema mismatch never breaks the UI in warn mode.
    expect(result).toEqual({ n: "not-a-number" });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[RPC:drift_probe] Output validation failed",
      expect.any(Array),
      "Raw:",
      { n: "not-a-number" }
    );
    expect(window.__orgiiRpcOutputDrift?.at(-1)?.command).toBe("drift_probe");
  });

  it("off mode: skips validation entirely (no console.error, no drift record)", async () => {
    setRpcOutputValidationMode("off");
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({ n: "bad" });

    const result = await rpcCall(numberProc);

    expect(result).toEqual({ n: "bad" });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(window.__orgiiRpcOutputDrift ?? []).toHaveLength(0);
  });

  it("throw mode: raises RpcError on drift (and still logs + records)", async () => {
    setRpcOutputValidationMode("throw");
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({ n: "bad" });

    await expect(rpcCall(numberProc)).rejects.toBeInstanceOf(RpcError);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(window.__orgiiRpcOutputDrift?.at(-1)?.command).toBe("drift_probe");
  });

  it("throw mode: passes valid output through without error", async () => {
    setRpcOutputValidationMode("throw");
    const consoleErrorSpy = vi.spyOn(console, "error");
    invokeMock.mockResolvedValue({ n: 42 });

    const result = await rpcCall(numberProc);

    expect(result).toEqual({ n: 42 });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(window.__orgiiRpcOutputDrift ?? []).toHaveLength(0);
  });

  it("mode getter/setter/reset round-trip", () => {
    expect(getRpcOutputValidationMode()).toBe("warn");
    setRpcOutputValidationMode("throw");
    expect(getRpcOutputValidationMode()).toBe("throw");
    setRpcOutputValidationMode("off");
    expect(getRpcOutputValidationMode()).toBe("off");
    resetRpcOutputValidationMode();
    expect(getRpcOutputValidationMode()).toBe("warn");
  });

  it("caps the drift ring buffer at 200 records", async () => {
    invokeMock.mockResolvedValue({ n: "bad" });
    for (let i = 0; i < 205; i += 1) {
      await rpcCall(numberProc);
    }
    expect(window.__orgiiRpcOutputDrift?.length).toBe(200);
  });
});
