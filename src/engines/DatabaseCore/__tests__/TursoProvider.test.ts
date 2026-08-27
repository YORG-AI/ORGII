import { beforeEach, describe, expect, it, vi } from "vitest";

import { TursoProvider } from "../providers/TursoProvider";
import type { TursoConnectionConfig } from "../types";

const { createClientMock, executeMock, closeMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  executeMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("@libsql/client", () => ({ createClient: createClientMock }));

const baseConfig: TursoConnectionConfig = {
  id: "turso-1",
  name: "Edge",
  type: "turso",
  createdAt: 0,
  updatedAt: 0,
  url: "libsql://app-org.turso.io",
  authToken: "ey.token",
};

type ResultSetLike = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
};

function resultSet(partial: Partial<ResultSetLike> = {}): ResultSetLike {
  return {
    columns: [],
    rows: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    ...partial,
  };
}

function makeProvider(
  overrides: Partial<TursoConnectionConfig> = {}
): TursoProvider {
  return new TursoProvider({ ...baseConfig, ...overrides });
}

async function connected(
  overrides: Partial<TursoConnectionConfig> = {}
): Promise<TursoProvider> {
  const provider = makeProvider(overrides);
  executeMock.mockResolvedValueOnce(resultSet());
  await provider.connect();
  executeMock.mockClear();
  return provider;
}

/** The nth call's SQL, whitespace-normalised (accepts string or statement form). */
function sqlAt(index: number): string {
  const arg = executeMock.mock.calls[index][0] as
    | string
    | { sql: string; args: unknown[] };
  const sql = typeof arg === "string" ? arg : arg.sql;
  return sql.replace(/\s+/g, " ").trim();
}

function argsAt(index: number): unknown[] {
  const arg = executeMock.mock.calls[index][0] as {
    sql: string;
    args: unknown[];
  };
  return arg.args;
}

beforeEach(() => {
  executeMock.mockReset();
  closeMock.mockReset();
  createClientMock
    .mockReset()
    .mockReturnValue({ execute: executeMock, close: closeMock });
});

describe("TursoProvider connection lifecycle", () => {
  it("passes url and authToken straight to createClient and probes with SELECT 1", async () => {
    const provider = makeProvider();
    executeMock.mockResolvedValue(resultSet());

    await provider.connect();

    expect(createClientMock).toHaveBeenCalledWith({
      url: "libsql://app-org.turso.io",
      authToken: "ey.token",
    });
    expect(executeMock).toHaveBeenCalledWith("SELECT 1");
    expect(provider.isConnected()).toBe(true);
    expect(provider.status.state).toBe("connected");
  });

  it("passes authToken as undefined for a token-less (local file) url", async () => {
    const provider = makeProvider({
      url: "file:local.db",
      authToken: undefined,
    });
    executeMock.mockResolvedValue(resultSet());

    await provider.connect();

    expect(createClientMock).toHaveBeenCalledWith({
      url: "file:local.db",
      authToken: undefined,
    });
  });

  it("does not create a second client when already connected", async () => {
    const provider = await connected();

    await provider.connect();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("drops the client and records the error when the probe fails", async () => {
    const provider = makeProvider();
    executeMock.mockRejectedValue(new Error("UNAUTHORIZED"));

    await expect(provider.connect()).rejects.toThrow("UNAUTHORIZED");
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "error", error: "UNAUTHORIZED" });
    // The dropped client is unreachable, so a later call must throw, not
    // silently reuse it.
    await expect(provider.getTables()).rejects.toThrow(
      "Database not connected. Call connect() first."
    );
  });

  it("uses a generic message when the driver rejects with a non-Error", async () => {
    const provider = makeProvider();
    executeMock.mockRejectedValue("socket hang up");

    await expect(provider.connect()).rejects.toBe("socket hang up");
    expect(provider.status).toEqual({
      state: "error",
      error: "Failed to connect",
    });
  });

  it.fails(
    "KNOWN BUG: a client created before a failed probe is leaked instead of closed",
    async () => {
      // connect() sets `this.client = null` in the catch block but never calls
      // close(), so the underlying HTTP/WS client and its sockets stay open.
      // Remove this `it.fails` once connect() closes the client on failure.
      const provider = makeProvider();
      executeMock.mockRejectedValue(new Error("UNAUTHORIZED"));

      await expect(provider.connect()).rejects.toThrow();

      expect(closeMock).toHaveBeenCalledTimes(1);
    }
  );

  it("closes the client on disconnect and allows a fresh connect afterwards", async () => {
    const provider = await connected();

    await provider.disconnect();

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "disconnected" });

    executeMock.mockResolvedValue(resultSet());
    await provider.connect();
    expect(createClientMock).toHaveBeenCalledTimes(2);
  });

  it("disconnecting without a client is a no-op", async () => {
    const provider = makeProvider();

    await provider.disconnect();

    expect(closeMock).not.toHaveBeenCalled();
    expect(provider.status).toEqual({ state: "disconnected" });
  });
});

describe("TursoProvider requires a connection", () => {
  const calls: [string, (p: TursoProvider) => Promise<unknown>][] = [
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
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("TursoProvider.getTables", () => {
  it("excludes sqlite_, _litestream_ and libsql_ internal objects", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet());

    await provider.getTables();

    // Pinned as exact SQL rather than fragments: the three NOT LIKE filters
    // and the ORDER BY direction are all contract, and a fragment assertion
    // cannot tell `ORDER BY name` from `ORDER BY name DESC`.
    expect(sqlAt(0)).toBe(
      "SELECT name, type FROM sqlite_master " +
        "WHERE type IN ('table', 'view') " +
        "AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT LIKE '_litestream_%' " +
        "AND name NOT LIKE 'libsql_%' " +
        "ORDER BY name"
    );
  });

  it("counts rows for tables but not for views", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            { name: "users", type: "table" },
            { name: "v_users", type: "view" },
          ],
        })
      )
      .mockResolvedValueOnce(resultSet({ rows: [{ count: 17 }] }));

    const tables = await provider.getTables();

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(sqlAt(1)).toBe('SELECT COUNT(*) as count FROM "users"');
    expect(tables).toEqual([
      { name: "users", type: "table", rowCount: 17 },
      { name: "v_users", type: "view" },
    ]);
  });

  it("keeps the table listed when its COUNT fails", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({ rows: [{ name: "users", type: "table" }] })
      )
      .mockRejectedValueOnce(new Error("no such table"));

    await expect(provider.getTables()).resolves.toEqual([
      { name: "users", type: "table" },
    ]);
  });
});

describe("TursoProvider.getTableSchema", () => {
  it("reads PRAGMA table_info and maps notnull/pk into ColumnInfo", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            {
              name: "id",
              type: "INTEGER",
              notnull: 1,
              pk: 1,
              dflt_value: null,
            },
            {
              name: "email",
              type: "TEXT",
              notnull: 0,
              pk: 0,
              dflt_value: "''",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        resultSet({
          rows: [{ sql: 'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY)' }],
        })
      );

    const schema = await provider.getTableSchema("users");

    expect(sqlAt(0)).toBe('PRAGMA table_info("users")');
    expect(schema).toEqual([
      {
        name: "id",
        type: "INTEGER",
        nullable: false,
        primaryKey: true,
        defaultValue: null,
        autoIncrement: true,
      },
      {
        name: "email",
        type: "TEXT",
        nullable: true,
        primaryKey: false,
        defaultValue: "''",
        autoIncrement: false,
      },
    ]);
  });

  it("detects AUTOINCREMENT anywhere in the CREATE statement", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            {
              name: "id",
              type: "INTEGER",
              notnull: 1,
              pk: 1,
              dflt_value: null,
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            { sql: "CREATE TABLE t (id integer primary key autoincrement)" },
          ],
        })
      );

    const [column] = await provider.getTableSchema("t");

    expect(column.autoIncrement).toBe(true);
  });

  it("does not claim autoIncrement for a non-integer primary key", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            { name: "uid", type: "TEXT", notnull: 1, pk: 1, dflt_value: null },
          ],
        })
      )
      .mockResolvedValueOnce(
        resultSet({
          rows: [{ sql: 'CREATE TABLE t ("uid" TEXT PRIMARY KEY)' }],
        })
      );

    const [column] = await provider.getTableSchema("t");

    expect(column.autoIncrement).toBe(false);
  });

  it("tolerates a missing sqlite_master row", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          rows: [
            {
              name: "id",
              type: "INTEGER",
              notnull: 0,
              pk: 0,
              dflt_value: null,
            },
          ],
        })
      )
      .mockResolvedValueOnce(resultSet({ rows: [] }));

    await expect(provider.getTableSchema("t")).resolves.toEqual([
      {
        name: "id",
        type: "INTEGER",
        nullable: true,
        primaryKey: false,
        defaultValue: null,
        autoIncrement: false,
      },
    ]);
  });

  it.fails(
    "KNOWN BUG: the sqlite_master lookup compares against a double-quoted identifier, not a string literal",
    async () => {
      // `name="users"` is an identifier reference in SQLite, not a string.
      // For a table named after a sqlite_master column ("name", "sql", "type",
      // "tbl_name") the predicate degenerates to `name = name` — always true —
      // and the CREATE statement of an unrelated table is used for the
      // AUTOINCREMENT probe. It should be `name = 'users'` with quotes doubled.
      // Remove this `it.fails` once the literal is quoted correctly.
      const provider = await connected();
      executeMock.mockResolvedValue(resultSet());

      await provider.getTableSchema("users");

      expect(sqlAt(1)).toBe(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
      );
    }
  );

  it("currently emits the double-quoted form (the defect above, pinned)", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet());

    await provider.getTableSchema("users");

    expect(sqlAt(1)).toBe(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=\"users\""
    );
  });
});

describe("TursoProvider.getTableData", () => {
  it("builds a quoted SELECT with LIMIT/OFFSET and no ORDER BY by default", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet());

    await provider.getTableData("users");

    expect(sqlAt(0)).toBe('SELECT * FROM "users" LIMIT 100 OFFSET 0');
  });

  it("appends ORDER BY with an uppercased direction and the right offset", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet());

    await provider.getTableData("users", {
      page: 2,
      pageSize: 20,
      orderBy: "name",
      orderDirection: "desc",
    });

    expect(sqlAt(0)).toBe(
      'SELECT * FROM "users" ORDER BY "name" DESC LIMIT 20 OFFSET 20'
    );
  });

  it("projects named rows into positional values following the column order", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(
        resultSet({
          columns: ["id", "name"],
          rows: [
            { id: 1, name: "Ada" },
            { id: 2, name: "Grace" },
          ],
        })
      )
      .mockResolvedValueOnce(resultSet({ rows: [{ count: 2 }] }));

    const result = await provider.getTableData("users");

    expect(result).toEqual({
      columns: ["id", "name"],
      values: [
        [1, "Ada"],
        [2, "Grace"],
      ],
      rowCount: 2,
      totalCount: 2,
      duration: expect.any(Number),
    });
    expect(sqlAt(1)).toBe('SELECT COUNT(*) as count FROM "users"');
  });

  it("returns an empty page with the total still populated", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(resultSet({ columns: ["id"], rows: [] }))
      .mockResolvedValueOnce(resultSet({ rows: [{ count: 5 }] }));

    await expect(provider.getTableData("users", { page: 99 })).resolves.toEqual(
      {
        columns: ["id"],
        values: [],
        rowCount: 0,
        totalCount: 5,
        duration: expect.any(Number),
      }
    );
  });

  it("reports totalCount 0 when the COUNT query returns no rows", async () => {
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(resultSet({ columns: ["id"], rows: [{ id: 1 }] }))
      .mockResolvedValueOnce(resultSet({ rows: [] }));

    await expect(provider.getTableData("users")).resolves.toMatchObject({
      totalCount: 0,
    });
  });

  it("propagates a failing COUNT — unlike the Postgres and MySQL providers", async () => {
    // Dialect difference worth pinning: Turso does not wrap the COUNT query in
    // a try/catch, so a permission error on COUNT fails the whole page read.
    const provider = await connected();
    executeMock
      .mockResolvedValueOnce(resultSet({ columns: ["id"], rows: [{ id: 1 }] }))
      .mockRejectedValueOnce(new Error("no such table"));

    await expect(provider.getTableData("users")).rejects.toThrow(
      "no such table"
    );
  });
});

describe("TursoProvider.query / execute", () => {
  it("passes SQL through and projects rows positionally", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(
      resultSet({ columns: ["a", "b"], rows: [{ a: 1, b: null }] })
    );

    const result = await provider.query("SELECT a, b FROM t");

    expect(sqlAt(0)).toBe("SELECT a, b FROM t");
    expect(result).toEqual({
      columns: ["a", "b"],
      values: [[1, null]],
      rowCount: 1,
      duration: expect.any(Number),
    });
  });

  it("returns an empty result set without inventing rows", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet({ columns: ["a"], rows: [] }));

    await expect(provider.query("SELECT a FROM t WHERE 0")).resolves.toEqual({
      columns: ["a"],
      values: [],
      rowCount: 0,
      duration: expect.any(Number),
    });
  });

  it("lets a failing query reject", async () => {
    const provider = await connected();
    executeMock.mockRejectedValue(new Error("no such column: zz"));

    await expect(provider.query("SELECT zz FROM t")).rejects.toThrow(
      "no such column: zz"
    );
  });

  it("converts a bigint lastInsertRowid to a number on execute", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(
      resultSet({ rowsAffected: 1, lastInsertRowid: 123n })
    );

    await expect(provider.execute("INSERT INTO t VALUES (1)")).resolves.toEqual(
      {
        success: true,
        rowsAffected: 1,
        duration: expect.any(Number),
        lastInsertId: 123,
      }
    );
  });

  it("omits lastInsertId when the driver reports none", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet({ rowsAffected: 3 }));

    await expect(provider.execute("UPDATE t SET a = 1")).resolves.toEqual({
      success: true,
      rowsAffected: 3,
      duration: expect.any(Number),
      lastInsertId: undefined,
    });
  });

  it("drops rowid 0 because the check is truthiness, not nullishness", async () => {
    // KNOWN DEFECT (reported): `lastInsertRowid ? ... : undefined` discards 0n.
    // SQLite rowids normally start at 1, so this is latent rather than active.
    const provider = await connected();
    executeMock.mockResolvedValue(
      resultSet({ rowsAffected: 1, lastInsertRowid: 0n })
    );

    const result = await provider.execute("INSERT INTO t VALUES (0)");

    expect(result.lastInsertId).toBeUndefined();
  });

  it("translates an execute failure into a failed ExecuteResult", async () => {
    const provider = await connected();
    executeMock.mockRejectedValue(new Error("UNIQUE constraint failed"));

    await expect(provider.execute("INSERT INTO t VALUES (1)")).resolves.toEqual(
      {
        success: false,
        rowsAffected: 0,
        duration: expect.any(Number),
        error: "UNIQUE constraint failed",
      }
    );
  });
});

describe("TursoProvider parameter binding", () => {
  it("binds insert values as ? placeholders instead of inlining literals", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(
      resultSet({ rowsAffected: 1, lastInsertRowid: 9n })
    );

    const result = await provider.insert("users", {
      name: "O'Brien",
      age: 42,
      bio: null,
    });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "users" ("name", "age", "bio") VALUES (?, ?, ?)'
    );
    expect(argsAt(0)).toEqual(["O'Brien", 42, null]);
    expect(sqlAt(0)).not.toContain("O'Brien");
    expect(result.lastInsertId).toBe(9);
  });

  it("normalises undefined to null so the driver accepts the binding", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet({ rowsAffected: 1 }));

    await provider.insert("users", { a: undefined, b: 1 });

    expect(argsAt(0)).toEqual([null, 1]);
  });

  it("binds update values before where values, in that order", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet({ rowsAffected: 1 }));

    await provider.update(
      "users",
      { name: "Ada", age: 36 },
      { id: 5, tenant: "acme" }
    );

    expect(sqlAt(0)).toBe(
      'UPDATE "users" SET "name" = ?, "age" = ? WHERE "id" = ? AND "tenant" = ?'
    );
    expect(argsAt(0)).toEqual(["Ada", 36, 5, "acme"]);
  });

  it("binds delete predicates positionally", async () => {
    const provider = await connected();
    executeMock.mockResolvedValue(resultSet({ rowsAffected: 2 }));

    await provider.delete("users", { tenant: "acme", archived: 0 });

    expect(sqlAt(0)).toBe(
      'DELETE FROM "users" WHERE "tenant" = ? AND "archived" = ?'
    );
    expect(argsAt(0)).toEqual(["acme", 0]);
  });

  it("labels non-Error rejections per operation instead of dropping them", async () => {
    // libsql can reject with a plain object; each write path has its own
    // fallback label so the caller can still tell what failed.
    const provider = await connected();
    executeMock.mockRejectedValue({ code: "SQLITE_BUSY" });

    await expect(provider.execute("VACUUM")).resolves.toMatchObject({
      success: false,
      error: "Execution failed",
    });
    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      error: "Insert failed",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ error: "Update failed" });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      error: "Delete failed",
    });
  });

  it("translates write failures into failed ExecuteResults", async () => {
    const provider = await connected();
    executeMock.mockRejectedValue(new Error("FOREIGN KEY constraint failed"));

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      success: false,
      error: "FOREIGN KEY constraint failed",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ success: false });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      success: false,
    });
  });

  it("save() is a no-op for a remote database", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
