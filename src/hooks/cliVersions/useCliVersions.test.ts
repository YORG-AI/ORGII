// @vitest-environment jsdom
import React, { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CliVersionSnapshot } from "@src/api/tauri/rpc/schemas/validation";

import { useCliVersions } from "./useCliVersions";

const mocks = vi.hoisted(() => ({
  scanCliVersion: vi.fn(),
}));

vi.mock("@src/api/services/keyValidation", () => ({
  scanCliVersion: mocks.scanCliVersion,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const codexSnapshot: CliVersionSnapshot = {
  agent_type: "codex",
  installed_version: "0.147.0",
  latest_version: "0.148.0",
  installed_version_error: null,
  latest_version_error: null,
  status: "outdated",
  scanned_at: new Date().toISOString(),
  stale: false,
};

describe("useCliVersions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let hook: ReturnType<typeof useCliVersions> | null;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const Harness = ({
    onReady,
  }: {
    onReady: (value: ReturnType<typeof useCliVersions>) => void;
  }) => {
    const value = useCliVersions();
    useEffect(() => onReady(value), [onReady, value]);
    return null;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.scanCliVersion.mockReset();
    hook = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        React.createElement(Harness, {
          onReady: (value) => {
            hook = value;
          },
        })
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("coalesces forced rechecks for exactly the selected CLI", async () => {
    const pending = deferred<CliVersionSnapshot>();
    mocks.scanCliVersion.mockReturnValue(pending.promise);

    let first!: Promise<CliVersionSnapshot>;
    let second!: Promise<CliVersionSnapshot>;
    act(() => {
      first = hook!.scanVersion("codex", true);
      second = hook!.scanVersion("codex", true);
    });

    expect(mocks.scanCliVersion).toHaveBeenCalledTimes(1);
    expect(mocks.scanCliVersion).toHaveBeenCalledWith("codex", true);

    await act(async () => {
      pending.resolve(codexSnapshot);
      await Promise.all([first, second]);
    });

    expect(hook?.getVersion("codex")).toMatchObject(codexSnapshot);
  });
});
