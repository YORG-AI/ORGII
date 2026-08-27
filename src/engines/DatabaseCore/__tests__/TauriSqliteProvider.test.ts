import { beforeEach, describe, expect, it, vi } from "vitest";

import { TauriSqliteProvider } from "../providers/TauriSqliteProvider";
import type { SqliteConnectionConfig } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const config: SqliteConnectionConfig = {
  id: "sqlite-1",
  name: "Local",
  type: "sqlite",
  createdAt: 0,
  updatedAt: 0,
  filePath: "/Users/me/app.db",
};

function makeProvider(): TauriSqliteProvider {
  return new TauriSqliteProvider(config);
}

async function connected(): Promise<TauriSqliteProvider> {
  const provider = makeProvider();
  invokeMock.mockResolvedValueOnce("handle-42");
  await provider.connect();
  invokeMock.mockClear();
  return provider;
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("TauriSqliteProvider connection lifecycle", () => {
  it("starts disconnected and exposes the supplied config", () => {
    const provider = makeProvider();

    expect(provider.type).toBe("sqlite");
    expect(provider.config).toBe(config);
    expect(provider.status).toEqual({ state: "disconnected" });
    expect(provider.isConnected()).toBe(false);
  });

  it("opens the file by path and records the connected timestamp", async () => {
    const provider = makeProvider();
    invokeMock.mockResolvedValue("handle-42");
    const before = Date.now();

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_open", {
      filePath: "/Users/me/app.db",
    });
    expect(provider.isConnected()).toBe(true);
    expect(provider.status.state).toBe("connected");
    if (provider.status.state === "connected") {
      expect(provider.status.connectedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("is idempotent — a second connect does not reopen the file", async () => {
    const provider = await connected();

    await provider.connect();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("records the driver message and rethrows when db_open fails", async () => {
    const provider = makeProvider();
    invokeMock.mockRejectedValue(new Error("unable to open database file"));

    await expect(provider.connect()).rejects.toThrow(
      "unable to open database file"
    );
    expect(provider.status).toEqual({
      state: "error",
      error: "unable to open database file",
    });
    expect(provider.isConnected()).toBe(false);
  });

  it("falls back to a generic message when the driver rejects with a non-Error", async () => {
    const provider = makeProvider();
    // Tauri rejects with a plain string for Rust-side `Err(String)`.
    invokeMock.mockRejectedValue("db_open: no such file");

    await expect(provider.connect()).rejects.toBe("db_open: no such file");
    expect(provider.status).toEqual({
      state: "error",
      error: "Failed to connect",
    });
  });

  it("closes the handle on disconnect and returns to disconnected", async () => {
    const provider = await connected();

    await provider.disconnect();

    expect(invokeMock).toHaveBeenCalledWith("db_close", {
      connectionId: "handle-42",
    });
    expect(provider.status).toEqual({ state: "disconnected" });
    expect(provider.isConnected()).toBe(false);
  });

  it("disconnecting an unopened provider is a no-op", async () => {
    const provider = makeProvider();

    await provider.disconnect();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(provider.status).toEqual({ state: "disconnected" });
  });

  it("reconnects after a disconnect", async () => {
    const provider = await connected();
    await provider.disconnect();
    invokeMock.mockClear().mockResolvedValue("handle-99");

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_open", {
      filePath: "/Users/me/app.db",
    });
    expect(provider.isConnected()).toBe(true);
  });

  it("save() is a no-op because Rust writes through to the file", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("TauriSqliteProvider guards every data call behind connect()", () => {
  const calls: [string, (p: TauriSqliteProvider) => Promise<unknown>][] = [
    ["getTables", (p) => p.getTables()],
    ["getTableSchema", (p) => p.getTableSchema("users")],
    ["getTableData", (p) => p.getTableData("users")],
    ["query", (p) => p.query("SELECT 1")],
    ["execute", (p) => p.execute("VACUUM")],
    ["insert", (p) => p.insert("users", { a: 1 })],
    ["update", (p) => p.update("users", { a: 1 }, { id: 2 })],
    ["delete", (p) => p.delete("users", { id: 2 })],
  ];

  it.each(calls)(
    "%s throws before connect and never invokes Tauri",
    async (_name, call) => {
      const provider = makeProvider();

      await expect(call(provider)).rejects.toThrow(
        "Database not connected. Call connect() first."
      );
      expect(invokeMock).not.toHaveBeenCalled();
    }
  );
});

describe("TauriSqliteProvider command payloads", () => {
  it("forwards the connection handle for getTables and returns rows unchanged", async () => {
    const provider = await connected();
    const tables = [{ name: "users", type: "table" as const, rowCount: 3 }];
    invokeMock.mockResolvedValue(tables);

    await expect(provider.getTables()).resolves.toBe(tables);
    expect(invokeMock).toHaveBeenCalledWith("db_get_tables", {
      connectionId: "handle-42",
    });
  });

  it("passes tableName through for getTableSchema", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue([]);

    await provider.getTableSchema("order_items");

    expect(invokeMock).toHaveBeenCalledWith("db_get_table_schema", {
      connectionId: "handle-42",
      tableName: "order_items",
    });
  });

  it("defaults getTableData options to an empty object", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      columns: [],
      values: [],
      rowCount: 0,
      duration: 0,
    });

    await provider.getTableData("users");

    expect(invokeMock).toHaveBeenCalledWith("db_get_table_data", {
      connectionId: "handle-42",
      tableName: "users",
      options: {},
    });
  });

  it("forwards paging and sort options verbatim to Rust", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      columns: [],
      values: [],
      rowCount: 0,
      duration: 0,
    });

    await provider.getTableData("users", {
      page: 3,
      pageSize: 25,
      orderBy: "created_at",
      orderDirection: "desc",
    });

    expect(invokeMock).toHaveBeenCalledWith("db_get_table_data", {
      connectionId: "handle-42",
      tableName: "users",
      options: {
        page: 3,
        pageSize: 25,
        orderBy: "created_at",
        orderDirection: "desc",
      },
    });
  });

  it("sends raw SQL untouched for query and returns the Rust result object", async () => {
    const provider = await connected();
    const result = {
      columns: ["id"],
      values: [[1]],
      rowCount: 1,
      duration: 2,
    };
    invokeMock.mockResolvedValue(result);

    await expect(provider.query("SELECT id FROM users -- ok")).resolves.toBe(
      result
    );
    expect(invokeMock).toHaveBeenCalledWith("db_query", {
      connectionId: "handle-42",
      sql: "SELECT id FROM users -- ok",
    });
  });

  it("sends raw SQL untouched for execute", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      success: true,
      rowsAffected: 4,
      duration: 1,
    });

    const result = await provider.execute("DELETE FROM users");

    expect(result.rowsAffected).toBe(4);
    expect(invokeMock).toHaveBeenCalledWith("db_execute", {
      connectionId: "handle-42",
      sql: "DELETE FROM users",
    });
  });

  it("hands insert data to Rust as a structured payload — no SQL is built here", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      success: true,
      rowsAffected: 1,
      duration: 1,
      lastInsertId: 7,
    });
    const data = { name: "O'Brien", tags: null, active: true };

    const result = await provider.insert("users", data);

    expect(invokeMock).toHaveBeenCalledWith("db_insert", {
      connectionId: "handle-42",
      tableName: "users",
      data,
    });
    expect(result.lastInsertId).toBe(7);
  });

  it("renames the update `where` argument to Rust's `whereClause`", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      success: true,
      rowsAffected: 1,
      duration: 1,
    });

    await provider.update("users", { name: "New" }, { id: 5 });

    expect(invokeMock).toHaveBeenCalledWith("db_update", {
      connectionId: "handle-42",
      tableName: "users",
      data: { name: "New" },
      whereClause: { id: 5 },
    });
  });

  it("renames the delete `where` argument to Rust's `whereClause`", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      success: true,
      rowsAffected: 2,
      duration: 1,
    });

    await provider.delete("users", { active: false });

    expect(invokeMock).toHaveBeenCalledWith("db_delete", {
      connectionId: "handle-42",
      tableName: "users",
      whereClause: { active: false },
    });
  });

  it("lets a failing write reject rather than swallowing it into ExecuteResult", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("UNIQUE constraint failed"));

    await expect(provider.insert("users", { id: 1 })).rejects.toThrow(
      "UNIQUE constraint failed"
    );
  });
});
