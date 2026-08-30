/**
 * Scan-update folding: latest wins, absent fields keep the previous value,
 * and a no-op update keeps object identity so duplicate subscribers are free.
 */
import { describe, expect, it } from "vitest";

import type { WorkspacePortScanResult } from "@src/api/tauri/workspacePorts";
import type { WorkspacePortsState } from "@src/store/workstation/codeEditor/workspacePortsAtom";

import { applyWorkspacePortScanUpdate } from "./workspacePortScanState";

const RESULT = { ports: [] } as unknown as WorkspacePortScanResult;

function state(
  overrides: Partial<WorkspacePortsState> = {}
): WorkspacePortsState {
  return {
    result: null,
    refreshing: false,
    lastScanStartedAt: 0,
    ...overrides,
  };
}

describe("applyWorkspacePortScanUpdate", () => {
  it("marks a scan in flight without dropping the previous result", () => {
    const previous = state({ result: RESULT, lastScanStartedAt: 100 });

    const next = applyWorkspacePortScanUpdate(previous, {
      refreshing: true,
      lastScanStartedAt: 200,
    });

    expect(next).toEqual({
      result: RESULT,
      refreshing: true,
      lastScanStartedAt: 200,
    });
  });

  it("stores the result and clears the in-flight flag when a scan lands", () => {
    const previous = state({ refreshing: true, lastScanStartedAt: 200 });

    const next = applyWorkspacePortScanUpdate(previous, {
      refreshing: false,
      result: RESULT,
      lastScanStartedAt: 200,
    });

    expect(next.result).toBe(RESULT);
    expect(next.refreshing).toBe(false);
  });

  it("keeps the last scan timestamp when an update omits it", () => {
    const previous = state({ lastScanStartedAt: 200 });

    const next = applyWorkspacePortScanUpdate(previous, { refreshing: false });

    expect(next.lastScanStartedAt).toBe(200);
  });

  it("returns the same object when the update changes nothing", () => {
    const previous = state({ result: RESULT, lastScanStartedAt: 200 });

    const next = applyWorkspacePortScanUpdate(previous, {
      refreshing: false,
      result: RESULT,
      lastScanStartedAt: 200,
    });

    expect(next).toBe(previous);
  });
});
