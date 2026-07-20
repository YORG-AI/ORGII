import { exists, readDir, stat } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyDirectoryOpenError,
  loadDirectoryEntries,
} from "./directoryExplorerUtils";

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  readDir: vi.fn(),
  stat: vi.fn(),
}));

const existsMock = vi.mocked(exists);
const readDirMock = vi.mocked(readDir);
const statMock = vi.mocked(stat);

describe("classifyDirectoryOpenError", () => {
  it.each([
    ["ENOENT: no such file or directory", "not_found"],
    ["ENOTDIR: not a directory", "not_directory"],
    ["EACCES: permission denied", "permission"],
    ["Failed to open path", "unknown"],
  ] as const)("classifies %s as %s", (message, kind) => {
    expect(classifyDirectoryOpenError(new Error(message)).kind).toBe(kind);
  });
});

describe("loadDirectoryEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMock.mockResolvedValue(true);
    statMock.mockResolvedValue({ isDirectory: true } as Awaited<
      ReturnType<typeof stat>
    >);
    readDirMock.mockResolvedValue([]);
  });

  it("reports a missing directory before trying to read it", async () => {
    existsMock.mockResolvedValue(false);

    await expect(loadDirectoryEntries("/repo/missing")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(statMock).not.toHaveBeenCalled();
    expect(readDirMock).not.toHaveBeenCalled();
  });

  it("reports paths that are files and does not call readDir", async () => {
    statMock.mockResolvedValue({ isDirectory: false } as Awaited<
      ReturnType<typeof stat>
    >);

    await expect(loadDirectoryEntries("/repo/file.ts")).rejects.toMatchObject({
      kind: "not_directory",
    });
    expect(readDirMock).not.toHaveBeenCalled();
  });

  it("preserves a permission failure from readDir", async () => {
    readDirMock.mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(loadDirectoryEntries("/repo/private")).rejects.toMatchObject({
      kind: "permission",
    });
  });

  it("sorts directories before files and names within each group", async () => {
    readDirMock.mockResolvedValue([
      { name: "z.ts", isDirectory: false },
      { name: "beta", isDirectory: true },
      { name: "alpha", isDirectory: true },
      { name: "a.ts", isDirectory: false },
    ] as Awaited<ReturnType<typeof readDir>>);

    await expect(loadDirectoryEntries("/repo/")).resolves.toEqual([
      { name: "alpha", path: "/repo/alpha", type: "directory" },
      { name: "beta", path: "/repo/beta", type: "directory" },
      { name: "a.ts", path: "/repo/a.ts", type: "file" },
      { name: "z.ts", path: "/repo/z.ts", type: "file" },
    ]);
  });
});
