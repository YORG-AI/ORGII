import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { popupNativeMenu } from "./nativeMenuPopup";

const tauriMenu = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  create: vi.fn(),
  popup: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: {
    new: tauriMenu.create,
  },
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
  });
}

describe("popupNativeMenu", () => {
  beforeEach(() => {
    tauriMenu.close.mockReset().mockResolvedValue(undefined);
    tauriMenu.popup.mockReset().mockResolvedValue(undefined);
    tauriMenu.create.mockReset().mockResolvedValue({
      close: tauriMenu.close,
      popup: tauriMenu.popup,
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("drops a concurrent request before building or creating its menu", async () => {
    const firstBuild = deferred<[{ text: string }]>();
    const duplicateBuild = vi.fn(() => [{ text: "Duplicate" }]);
    const onBusy = vi.fn();

    const firstResultPromise = popupNativeMenu({
      source: "file-explorer",
      buildItems: () => firstBuild.promise,
    });
    const duplicateResult = await popupNativeMenu({
      source: "tab-context-menu",
      buildItems: duplicateBuild,
      onBusy,
    });

    expect(duplicateBuild).not.toHaveBeenCalled();
    expect(tauriMenu.create).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenCalledWith("file-explorer");
    expect(duplicateResult).toEqual({
      status: "busy",
      activeSource: "file-explorer",
    });

    firstBuild.resolve([{ text: "First" }]);
    await expect(firstResultPromise).resolves.toEqual({ status: "closed" });
  });

  it("creates one menu from plain options and closes it after popup", async () => {
    const items = [{ text: "Open", action: vi.fn() }];

    await expect(
      popupNativeMenu({ source: "main", buildItems: () => items })
    ).resolves.toEqual({ status: "closed" });

    expect(tauriMenu.create).toHaveBeenCalledOnce();
    expect(tauriMenu.create).toHaveBeenCalledWith({ items });
    expect(tauriMenu.popup).toHaveBeenCalledOnce();
    expect(tauriMenu.close).toHaveBeenCalledOnce();
    expect(tauriMenu.popup.mock.invocationCallOrder[0]).toBeLessThan(
      tauriMenu.close.mock.invocationCallOrder[0]
    );
  });

  it("does not allocate a menu when the builder returns no items", async () => {
    await expect(
      popupNativeMenu({ source: "empty", buildItems: () => [] })
    ).resolves.toEqual({ status: "empty" });

    expect(tauriMenu.create).not.toHaveBeenCalled();
  });

  it("releases the gate when building or menu creation rejects", async () => {
    const buildFailure = new Error("build failed");
    await expect(
      popupNativeMenu({
        source: "build-failure",
        buildItems: () => {
          throw buildFailure;
        },
      })
    ).rejects.toBe(buildFailure);

    const createFailure = new Error("create failed");
    tauriMenu.create.mockRejectedValueOnce(createFailure);
    await expect(
      popupNativeMenu({
        source: "create-failure",
        buildItems: () => [{ text: "Create" }],
      })
    ).rejects.toBe(createFailure);

    await expect(
      popupNativeMenu({
        source: "post-create-recovery",
        buildItems: () => [{ text: "Recovered" }],
      })
    ).resolves.toEqual({ status: "closed" });
  });

  it("closes the menu and releases the gate when popup rejects", async () => {
    const failure = new Error("popup failed");
    tauriMenu.popup.mockRejectedValueOnce(failure);

    await expect(
      popupNativeMenu({
        source: "broken-menu",
        buildItems: () => [{ text: "Broken" }],
      })
    ).rejects.toBe(failure);
    expect(tauriMenu.close).toHaveBeenCalledOnce();

    await expect(
      popupNativeMenu({
        source: "recovery-menu",
        buildItems: () => [{ text: "Recovered" }],
      })
    ).resolves.toEqual({ status: "closed" });
  });

  it("releases the gate when resource cleanup rejects", async () => {
    const closeFailure = new Error("close failed");
    tauriMenu.close.mockRejectedValueOnce(closeFailure);

    await expect(
      popupNativeMenu({
        source: "close-failure",
        buildItems: () => [{ text: "Close" }],
      })
    ).rejects.toBe(closeFailure);

    await expect(
      popupNativeMenu({
        source: "post-close-recovery",
        buildItems: () => [{ text: "Recovered" }],
      })
    ).resolves.toEqual({ status: "closed" });
  });

  it("preserves popup and cleanup failures together", async () => {
    const popupFailure = new Error("popup failed");
    const closeFailure = new Error("close failed");
    tauriMenu.popup.mockRejectedValueOnce(popupFailure);
    tauriMenu.close.mockRejectedValueOnce(closeFailure);

    await expect(
      popupNativeMenu({
        source: "double-failure",
        buildItems: () => [{ text: "Broken" }],
      })
    ).rejects.toMatchObject({
      errors: [popupFailure, closeFailure],
      message: "Native menu popup and cleanup both failed",
    });
  });

  it("uses cursor fallback only when explicitly requested", async () => {
    const positionedFailure = new Error("position unsupported");
    const position = { type: "Logical", x: 10, y: 20 } as never;
    tauriMenu.popup.mockRejectedValueOnce(positionedFailure);

    await expect(
      popupNativeMenu({
        source: "windows-menu",
        buildItems: () => [{ text: "File" }],
        at: position,
        fallbackToCursor: true,
      })
    ).resolves.toEqual({ status: "closed" });

    expect(tauriMenu.popup).toHaveBeenNthCalledWith(1, position);
    expect(tauriMenu.popup).toHaveBeenNthCalledWith(2);
    expect(tauriMenu.close).toHaveBeenCalledOnce();
  });

  it("does not hide a positioned popup failure without fallback", async () => {
    const positionedFailure = new Error("position unsupported");
    const position = { type: "Logical", x: 10, y: 20 } as never;
    tauriMenu.popup.mockRejectedValueOnce(positionedFailure);

    await expect(
      popupNativeMenu({
        source: "positioned-menu",
        buildItems: () => [{ text: "File" }],
        at: position,
      })
    ).rejects.toBe(positionedFailure);

    expect(tauriMenu.popup).toHaveBeenCalledOnce();
    expect(tauriMenu.close).toHaveBeenCalledOnce();
  });

  it("shares the active gate across hot module reloads", async () => {
    const activeBuild = deferred<[{ text: string }]>();
    const firstResultPromise = popupNativeMenu({
      source: "pre-reload-menu",
      buildItems: () => activeBuild.promise,
    });

    vi.resetModules();
    const reloadedModule = await import("./nativeMenuPopup");
    const reloadedBuild = vi.fn(() => [{ text: "Reloaded" }]);
    await expect(
      reloadedModule.popupNativeMenu({
        source: "post-reload-menu",
        buildItems: reloadedBuild,
      })
    ).resolves.toEqual({
      status: "busy",
      activeSource: "pre-reload-menu",
    });
    expect(reloadedBuild).not.toHaveBeenCalled();

    activeBuild.resolve([{ text: "Active" }]);
    await firstResultPromise;
  });

  it("keeps all native menu IPC and resource ownership in this module", () => {
    const sourceRoot = path.resolve(process.cwd(), "src");
    const ownerFile = path.resolve(
      sourceRoot,
      "util/platform/tauri/nativeMenuPopup.ts"
    );
    const forbiddenPatterns = [
      /@tauri-apps\/api\/menu/,
      /\b(?:Menu|TauriMenu|MenuItem|PredefinedMenuItem)\.new\s*\(/,
      /\.popup\s*\(/,
    ];
    const violatingFiles = listSourceFiles(sourceRoot)
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => file !== ownerFile)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return forbiddenPatterns.some((pattern) => pattern.test(source));
      })
      .map((file) => path.relative(sourceRoot, file));

    expect(violatingFiles).toEqual([]);
  });
});
