import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresProvider } from "../providers/PostgresProvider";
import type { PostgresConnectionConfig } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const baseConfig: PostgresConnectionConfig = {
  id: "pg-1",
  name: "Prod",
  type: "postgres",
  createdAt: 0,
  updatedAt: 0,
  host: "db.example.com",
  port: 5432,
  database: "app",
  user: "admin",
};

function makeProvider(
  overrides: Partial<PostgresConnectionConfig> = {}
): PostgresProvider {
  return new PostgresProvider({ ...baseConfig, ...overrides });
}

/** Connect a provider and clear the connect call from the mock history. */
async function connected(
  overrides: Partial<PostgresConnectionConfig> = {}
): Promise<PostgresProvider> {
  const provider = makeProvider(overrides);
  invokeMock.mockResolvedValueOnce(undefined);
  await provider.connect();
  invokeMock.mockClear();
  return provider;
}

/** Whitespace-normalised SQL of the nth `db_sql_query`/`db_sql_execute` call. */
function sqlAt(index: number): string {
  const call = invokeMock.mock.calls[index];
  return String((call[1] as { sql: string }).sql)
    .replace(/\s+/g, " ")
    .trim();
}

const emptyQueryResult = { columns: [], rows: [], row_count: 0 };

beforeEach(() => {
  invokeMock.mockReset();
});

describe("PostgresProvider connection string", () => {
  it("includes user:password and sslmode=require when ssl is on", async () => {
    const provider = makeProvider({ password: "s3cret", ssl: true });
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_connect", {
      connectionId: "pg-1",
      dbType: "postgres",
      connectionString:
        "postgres://admin:s3cret@db.example.com:5432/app?sslmode=require",
    });
  });

  it("omits the colon when no password is configured and defaults to sslmode=prefer", async () => {
    const provider = makeProvider();
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_connect", {
      connectionId: "pg-1",
      dbType: "postgres",
      connectionString:
        "postgres://admin@db.example.com:5432/app?sslmode=prefer",
    });
  });

  it("treats an empty-string password as absent", async () => {
    const provider = makeProvider({ password: "" });
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    const { connectionString } = invokeMock.mock.calls[0][1] as {
      connectionString: string;
    };
    expect(connectionString).toBe(
      "postgres://admin@db.example.com:5432/app?sslmode=prefer"
    );
  });

  it("does not URL-encode credentials — a password with @ or / corrupts the DSN", async () => {
    // KNOWN DEFECT (reported): buildConnectionString interpolates the raw
    // password, so reserved URI characters silently redirect the host.
    const provider = makeProvider({ password: "p@ss/word" });
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    const { connectionString } = invokeMock.mock.calls[0][1] as {
      connectionString: string;
    };
    expect(connectionString).toBe(
      "postgres://admin:p@ss/word@db.example.com:5432/app?sslmode=prefer"
    );
  });
});

describe("PostgresProvider connection lifecycle", () => {
  it("is disconnected until connect resolves", async () => {
    const provider = makeProvider();
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "disconnected" });

    invokeMock.mockResolvedValue(undefined);
    await provider.connect();

    expect(provider.isConnected()).toBe(true);
    expect(provider.status.state).toBe("connected");
  });

  it("does not reconnect when already connected", async () => {
    const provider = await connected();

    await provider.connect();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("surfaces the driver message as an Error and records it on status", async () => {
    const provider = makeProvider();
    invokeMock.mockRejectedValue(new Error("password authentication failed"));

    await expect(provider.connect()).rejects.toThrow(
      "password authentication failed"
    );
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({
      state: "error",
      error: "password authentication failed",
    });
  });

  it("stringifies a non-Error rejection instead of losing it", async () => {
    const provider = makeProvider();
    invokeMock.mockRejectedValue("connection refused");

    await expect(provider.connect()).rejects.toThrow("connection refused");
    expect(provider.status).toEqual({
      state: "error",
      error: "connection refused",
    });
  });

  it("disconnects best-effort and still reports disconnected when the backend errors", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("pool already closed"));

    await expect(provider.disconnect()).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_disconnect", {
      connectionId: "pg-1",
    });
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "disconnected" });
  });

  it("skips the backend call when disconnecting an unconnected provider", async () => {
    const provider = makeProvider();

    await provider.disconnect();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("PostgresProvider requires a connection", () => {
  const calls: [string, (p: PostgresProvider) => Promise<unknown>][] = [
    ["getTables", (p) => p.getTables()],
    ["getTableSchema", (p) => p.getTableSchema("users")],
    ["getTableData", (p) => p.getTableData("users")],
    ["query", (p) => p.query("SELECT 1")],
    ["execute", (p) => p.execute("VACUUM")],
    ["insert", (p) => p.insert("users", { a: 1 })],
    ["update", (p) => p.update("users", { a: 1 }, { id: 1 })],
    ["delete", (p) => p.delete("users", { id: 1 })],
  ];

  it.each(calls)("%s refuses to run while disconnected", async (_n, call) => {
    const provider = makeProvider();

    await expect(call(provider)).rejects.toThrow(
      "Database not connected. Call connect() first."
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("PostgresProvider schema reads", () => {
  it("maps Rust snake_case table rows onto TableInfo", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue([
      { name: "users", table_type: "BASE TABLE", row_count: 12 },
      { name: "active_users", table_type: "VIEW", row_count: null },
    ]);

    await expect(provider.getTables()).resolves.toEqual([
      { name: "users", type: "table", rowCount: 12 },
      { name: "active_users", type: "view", rowCount: undefined },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("db_sql_get_tables", {
      connectionId: "pg-1",
    });
  });

  it("maps Rust snake_case column rows onto ColumnInfo", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue([
      {
        name: "id",
        data_type: "int4",
        nullable: false,
        primary_key: true,
        default_value: "nextval('users_id_seq')",
        auto_increment: true,
      },
    ]);

    await expect(provider.getTableSchema("users")).resolves.toEqual([
      {
        name: "id",
        type: "int4",
        nullable: false,
        primaryKey: true,
        defaultValue: "nextval('users_id_seq')",
        autoIncrement: true,
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("db_sql_get_table_schema", {
      connectionId: "pg-1",
      tableName: "users",
    });
  });
});

describe("PostgresProvider.getTableData SQL", () => {
  it("defaults to page 1 / 100 rows with no ORDER BY", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue(emptyQueryResult);

    await provider.getTableData("users");

    expect(sqlAt(0)).toBe('SELECT * FROM "users" LIMIT 100 OFFSET 0');
  });

  it("computes OFFSET from page and pageSize and uppercases the direction", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue(emptyQueryResult);

    await provider.getTableData("users", {
      page: 3,
      pageSize: 25,
      orderBy: "created_at",
      orderDirection: "desc",
    });

    expect(sqlAt(0)).toBe(
      'SELECT * FROM "users" ORDER BY "created_at" DESC LIMIT 25 OFFSET 50'
    );
  });

  it("issues a separate COUNT(*) and merges it as totalCount", async () => {
    const provider = await connected();
    invokeMock
      .mockResolvedValueOnce({
        columns: ["id"],
        rows: [[1], [2]],
        row_count: 2,
      })
      .mockResolvedValueOnce({
        columns: ["count"],
        rows: [[42]],
        row_count: 1,
      });

    const result = await provider.getTableData("users");

    expect(sqlAt(1)).toBe('SELECT COUNT(*) as count FROM "users"');
    expect(result).toEqual({
      columns: ["id"],
      values: [[1], [2]],
      rowCount: 2,
      totalCount: 42,
      duration: expect.any(Number),
    });
  });

  it("still returns the page when the COUNT query fails", async () => {
    const provider = await connected();
    invokeMock
      .mockResolvedValueOnce({ columns: ["id"], rows: [[1]], row_count: 1 })
      .mockRejectedValueOnce(new Error("permission denied for table users"));

    const result = await provider.getTableData("users");

    expect(result.totalCount).toBeUndefined();
    expect(result.rowCount).toBe(1);
  });

  it("leaves totalCount undefined when COUNT returns no rows", async () => {
    const provider = await connected();
    invokeMock
      .mockResolvedValueOnce({ columns: ["id"], rows: [[1]], row_count: 1 })
      .mockResolvedValueOnce({ columns: ["count"], rows: [], row_count: 0 });

    const result = await provider.getTableData("users");

    expect(result.totalCount).toBeUndefined();
  });

  it("does not quote-escape the table identifier", async () => {
    // KNOWN DEFECT (reported): an embedded double quote is not doubled, so a
    // hostile identifier escapes the quoted-identifier context.
    const provider = await connected();
    invokeMock.mockResolvedValue(emptyQueryResult);

    await provider.getTableData('users" ; DROP TABLE secrets --');

    expect(sqlAt(0)).toBe(
      'SELECT * FROM "users" ; DROP TABLE secrets --" LIMIT 100 OFFSET 0'
    );
  });
});

describe("PostgresProvider.query / execute", () => {
  it("passes user SQL through untouched and renames row_count to rowCount", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      columns: ["a", "b"],
      rows: [
        [1, "x"],
        [2, "y"],
      ],
      row_count: 2,
    });

    const result = await provider.query("SELECT a, b FROM t WHERE a > 0");

    expect(sqlAt(0)).toBe("SELECT a, b FROM t WHERE a > 0");
    expect(result).toEqual({
      columns: ["a", "b"],
      values: [
        [1, "x"],
        [2, "y"],
      ],
      rowCount: 2,
      duration: expect.any(Number),
    });
    expect(result).not.toHaveProperty("totalCount");
  });

  it("lets a failing query reject — only execute() swallows errors", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error('relation "nope" does not exist'));

    await expect(provider.query("SELECT * FROM nope")).rejects.toThrow(
      'relation "nope" does not exist'
    );
  });

  it("reports execute success with the affected row count", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 3 });

    const result = await provider.execute("UPDATE t SET a = 1");

    expect(result).toEqual({
      success: true,
      rowsAffected: 3,
      duration: expect.any(Number),
    });
  });

  it("translates an execute failure into a failed ExecuteResult", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error('syntax error at or near "FRM"'));

    const result = await provider.execute("SELCT 1");

    expect(result).toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: 'syntax error at or near "FRM"',
    });
  });

  it("stringifies non-Error execute failures", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue({ code: "42601" });

    const result = await provider.execute("SELCT 1");

    expect(result.success).toBe(false);
    expect(result.error).toBe("[object Object]");
  });
});

describe("PostgresProvider.insert SQL and value literals", () => {
  it("quotes identifiers and emits typed literals in column order", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    const result = await provider.insert("users", {
      id: 7,
      name: "Ada",
      active: true,
      deleted: false,
      bio: null,
      nickname: undefined,
      meta: { role: "admin" },
    });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "users" ("id", "name", "active", "deleted", "bio", "nickname", "meta") ' +
        "VALUES (7, 'Ada', TRUE, FALSE, NULL, NULL, '{\"role\":\"admin\"}'::jsonb)"
    );
    expect(result).toEqual({
      success: true,
      rowsAffected: 1,
      duration: expect.any(Number),
    });
  });

  it("doubles single quotes so an apostrophe cannot terminate the literal", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("users", { name: "O'Brien'; DROP TABLE users --" });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "users" ("name") ' +
        "VALUES ('O''Brien''; DROP TABLE users --')"
    );
  });

  it("keeps a backslash literal — Postgres standard_conforming_strings makes this safe", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { a: "x\\", b: "y" });

    expect(sqlAt(0)).toBe('INSERT INTO "t" ("a", "b") VALUES (\'x\\\', \'y\')');
  });

  it("quotes a bigint instead of emitting it as a bare numeric literal", async () => {
    // BIGINT columns come back from drivers as JS BigInt, which is neither
    // `number` nor `object`, so it takes the String() fallback branch.
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { id: 9007199254740993n });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "t" ("id") VALUES (\'9007199254740993\')'
    );
  });

  it("serialises a Date as a jsonb string rather than a timestamp", async () => {
    // KNOWN DEFECT (reported): `typeof new Date() === "object"`, so Dates take
    // the JSON.stringify branch and land as jsonb, not timestamptz.
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { at: new Date("2026-01-02T03:04:05.000Z") });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "t" ("at") VALUES (\'"2026-01-02T03:04:05.000Z"\'::jsonb)'
    );
  });

  it("escapes quotes inside a serialised object", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { meta: { note: "it's fine" } });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "t" ("meta") VALUES (\'{"note":"it\'\'s fine"}\'::jsonb)'
    );
  });

  it("translates an insert failure into a failed ExecuteResult", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("duplicate key value"));

    await expect(provider.insert("users", { id: 1 })).resolves.toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: "duplicate key value",
    });
  });
});

describe("PostgresProvider.update / delete SQL", () => {
  it("builds a comma-joined SET and an AND-joined WHERE", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 2 });

    const result = await provider.update(
      "users",
      { name: "Ada", active: true },
      { id: 5, tenant: "acme" }
    );

    expect(sqlAt(0)).toBe(
      'UPDATE "users" SET "name" = \'Ada\', "active" = TRUE ' +
        'WHERE "id" = 5 AND "tenant" = \'acme\''
    );
    expect(result.rowsAffected).toBe(2);
  });

  it("builds an AND-joined WHERE for delete", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.delete("users", { id: 5, archived: false });

    expect(sqlAt(0)).toBe(
      'DELETE FROM "users" WHERE "id" = 5 AND "archived" = FALSE'
    );
  });

  it("emits an unbounded DELETE when the where map is empty", async () => {
    // KNOWN DEFECT (reported): `WHERE ` with no predicate is a syntax error at
    // best; the guard belongs in the provider, not in the caller.
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 0 });

    await provider.delete("users", {});

    expect(sqlAt(0)).toBe('DELETE FROM "users" WHERE');
  });

  it("translates update and delete failures into failed ExecuteResults", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("deadlock detected"));

    await expect(
      provider.update("users", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ success: false, error: "deadlock detected" });
    await expect(provider.delete("users", { id: 1 })).resolves.toMatchObject({
      success: false,
      error: "deadlock detected",
    });
  });
});

describe("PostgresProvider.save", () => {
  it("is a no-op for a remote database", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("PostgresProvider non-Error rejections on write paths", () => {
  it("stringifies a non-Error rejection rather than losing the reason", async () => {
    // Tauri rejects with a plain string for a Rust-side `Err(String)`.
    const provider = await connected();
    invokeMock.mockRejectedValue("23505 duplicate key value");

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      success: false,
      error: "23505 duplicate key value",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ error: "23505 duplicate key value" });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      error: "23505 duplicate key value",
    });
  });
});
