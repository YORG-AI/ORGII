import { beforeEach, describe, expect, it, vi } from "vitest";

import { isValidSqliteFile } from "../providers/isValidSqliteFile";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("isValidSqliteFile", () => {
  it("delegates to db_is_valid_sqlite_file with the camelCase filePath key", async () => {
    invokeMock.mockResolvedValue(true);

    await isValidSqliteFile("/Users/me/Library/app.db");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("db_is_valid_sqlite_file", {
      filePath: "/Users/me/Library/app.db",
    });
  });

  it("returns the backend verdict verbatim", async () => {
    invokeMock.mockResolvedValueOnce(true);
    await expect(isValidSqliteFile("/ok.db")).resolves.toBe(true);

    invokeMock.mockResolvedValueOnce(false);
    await expect(isValidSqliteFile("/not-sqlite.txt")).resolves.toBe(false);
  });

  it("propagates backend failures rather than reporting the file as invalid", async () => {
    invokeMock.mockRejectedValue(new Error("permission denied"));

    await expect(isValidSqliteFile("/root/secret.db")).rejects.toThrow(
      "permission denied"
    );
  });
});
