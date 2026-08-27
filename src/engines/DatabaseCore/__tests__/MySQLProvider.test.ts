import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySQLProvider } from "../providers/MySQLProvider";
import type { MySQLConnectionConfig } from "../types";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const baseConfig: MySQLConnectionConfig = {
  id: "my-1",
  name: "Prod",
  type: "mysql",
  createdAt: 0,
  updatedAt: 0,
  host: "mysql.example.com",
  port: 3306,
  database: "app",
  user: "root",
};

function makeProvider(
  overrides: Partial<MySQLConnectionConfig> = {}
): MySQLProvider {
  return new MySQLProvider({ ...baseConfig, ...overrides });
}

async function connected(
  overrides: Partial<MySQLConnectionConfig> = {}
): Promise<MySQLProvider> {
  const provider = makeProvider(overrides);
  invokeMock.mockResolvedValueOnce(undefined);
  await provider.connect();
  invokeMock.mockClear();
  return provider;
}

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

describe("MySQLProvider connection string", () => {
  it("uses the mysql scheme and ssl-mode=REQUIRED when ssl is on", async () => {
    const provider = makeProvider({ password: "s3cret", ssl: true });
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_connect", {
      connectionId: "my-1",
      dbType: "mysql",
      connectionString:
        "mysql://root:s3cret@mysql.example.com:3306/app?ssl-mode=REQUIRED",
    });
  });

  it("defaults to ssl-mode=PREFERRED and omits an absent password", async () => {
    const provider = makeProvider();
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_connect", {
      connectionId: "my-1",
      dbType: "mysql",
      connectionString:
        "mysql://root@mysql.example.com:3306/app?ssl-mode=PREFERRED",
    });
  });

  it("uses MySQL's ssl-mode key, not Postgres's sslmode", async () => {
    const provider = makeProvider({ ssl: true });
    invokeMock.mockResolvedValue(undefined);

    await provider.connect();

    const { connectionString } = invokeMock.mock.calls[0][1] as {
      connectionString: string;
    };
    expect(connectionString).toContain("?ssl-mode=");
    expect(connectionString).not.toContain("?sslmode=");
  });
});

describe("MySQLProvider connection lifecycle", () => {
  it("records the error message and rethrows it as an Error", async () => {
    const provider = makeProvider();
    invokeMock.mockRejectedValue(new Error("Access denied for user 'root'"));

    await expect(provider.connect()).rejects.toThrow(
      "Access denied for user 'root'"
    );
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({
      state: "error",
      error: "Access denied for user 'root'",
    });
  });

  it("stringifies a non-Error rejection", async () => {
    const provider = makeProvider();
    invokeMock.mockRejectedValue("ER_BAD_DB_ERROR");

    await expect(provider.connect()).rejects.toThrow("ER_BAD_DB_ERROR");
    expect(provider.status).toEqual({
      state: "error",
      error: "ER_BAD_DB_ERROR",
    });
  });

  it("does not reconnect when already connected", async () => {
    const provider = await connected();

    await provider.connect();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("swallows a disconnect failure but still clears the state", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("broken pipe"));

    await expect(provider.disconnect()).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledWith("db_sql_disconnect", {
      connectionId: "my-1",
    });
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "disconnected" });
  });

  it("skips the backend call when never connected", async () => {
    const provider = makeProvider();

    await provider.disconnect();

    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("MySQLProvider requires a connection", () => {
  const calls: [string, (p: MySQLProvider) => Promise<unknown>][] = [
    ["getTables", (p) => p.getTables()],
    ["getTableSchema", (p) => p.getTableSchema("users")],
    ["getTableData", (p) => p.getTableData("users")],
    ["query", (p) => p.query("SELECT 1")],
    ["execute", (p) => p.execute("OPTIMIZE TABLE t")],
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

describe("MySQLProvider schema reads", () => {
  it("maps table rows and treats table_type VIEW as a view", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue([
      { name: "orders", table_type: "BASE TABLE", row_count: 4 },
      { name: "v_orders", table_type: "VIEW", row_count: null },
    ]);

    await expect(provider.getTables()).resolves.toEqual([
      { name: "orders", type: "table", rowCount: 4 },
      { name: "v_orders", type: "view", rowCount: undefined },
    ]);
  });

  it("maps column rows onto ColumnInfo", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue([
      {
        name: "id",
        data_type: "bigint",
        nullable: false,
        primary_key: true,
        default_value: null,
        auto_increment: true,
      },
    ]);

    await expect(provider.getTableSchema("orders")).resolves.toEqual([
      {
        name: "id",
        type: "bigint",
        nullable: false,
        primaryKey: true,
        defaultValue: null,
        autoIncrement: true,
      },
    ]);
  });
});

describe("MySQLProvider.getTableData SQL", () => {
  it("quotes identifiers with backticks, not double quotes", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue(emptyQueryResult);

    await provider.getTableData("users");

    expect(sqlAt(0)).toBe("SELECT * FROM `users` LIMIT 100 OFFSET 0");
  });

  it("computes OFFSET and uppercases the sort direction", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue(emptyQueryResult);

    await provider.getTableData("users", {
      page: 4,
      pageSize: 10,
      orderBy: "created_at",
      orderDirection: "desc",
    });

    expect(sqlAt(0)).toBe(
      "SELECT * FROM `users` ORDER BY `created_at` DESC LIMIT 10 OFFSET 30"
    );
  });

  it("merges the COUNT(*) result as totalCount", async () => {
    const provider = await connected();
    invokeMock
      .mockResolvedValueOnce({ columns: ["id"], rows: [[1]], row_count: 1 })
      .mockResolvedValueOnce({ columns: ["count"], rows: [[9]], row_count: 1 });

    const result = await provider.getTableData("users");

    expect(sqlAt(1)).toBe("SELECT COUNT(*) as count FROM `users`");
    expect(result.totalCount).toBe(9);
  });

  it("ignores a failing COUNT query", async () => {
    const provider = await connected();
    invokeMock
      .mockResolvedValueOnce({ columns: ["id"], rows: [[1]], row_count: 1 })
      .mockRejectedValueOnce(new Error("SELECT command denied"));

    await expect(provider.getTableData("users")).resolves.toMatchObject({
      rowCount: 1,
      totalCount: undefined,
    });
  });
});

describe("MySQLProvider value literals", () => {
  it("renders booleans as 1/0 rather than TRUE/FALSE", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("flags", { on: true, off: false });

    expect(sqlAt(0)).toBe("INSERT INTO `flags` (`on`, `off`) VALUES (1, 0)");
  });

  it("serialises objects as plain JSON strings with no ::jsonb cast", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { meta: { role: "admin" } });

    expect(sqlAt(0)).toBe(
      'INSERT INTO `t` (`meta`) VALUES (\'{"role":"admin"}\')'
    );
    expect(sqlAt(0)).not.toContain("::jsonb");
  });

  it("maps null and undefined to NULL and numbers unquoted", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { a: null, b: undefined, c: 3.5 });

    expect(sqlAt(0)).toBe(
      "INSERT INTO `t` (`a`, `b`, `c`) VALUES (NULL, NULL, 3.5)"
    );
  });

  it("doubles single quotes inside string literals", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("users", { name: "O'Brien" });

    expect(sqlAt(0)).toBe("INSERT INTO `users` (`name`) VALUES ('O''Brien')");
  });

  it("quotes a bigint instead of emitting it as a bare numeric literal", async () => {
    // BIGINT columns come back from drivers as JS BigInt, which is neither
    // `number` nor `object`, so it takes the String() fallback branch.
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { id: 9007199254740993n });

    expect(sqlAt(0)).toBe("INSERT INTO `t` (`id`) VALUES ('9007199254740993')");
  });

  it.fails(
    "KNOWN BUG: a trailing backslash escapes the closing quote under MySQL's default backslash handling",
    async () => {
      // MySQL treats `\` as an escape character inside string literals unless
      // NO_BACKSLASH_ESCAPES is set, so `'x\'` does not terminate the literal
      // and the following column value is absorbed as SQL.
      // formatMySqlValue only doubles `'`; it never escapes `\`.
      // Remove this `it.fails` once the escaping is fixed.
      const provider = await connected();
      invokeMock.mockResolvedValue({ rows_affected: 1 });

      await provider.insert("t", { a: "x\\", b: "y" });

      expect(sqlAt(0)).toBe("INSERT INTO `t` (`a`, `b`) VALUES ('x\\\\', 'y')");
    }
  );

  it("currently emits an unescaped backslash (the defect above, pinned)", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { a: "x\\", b: "y" });

    // The literal `'x\'` leaves the string open in MySQL default mode.
    expect(sqlAt(0)).toBe("INSERT INTO `t` (`a`, `b`) VALUES ('x\\', 'y')");
  });
});

describe("MySQLProvider write SQL", () => {
  it("builds an INSERT with backtick-quoted columns in insertion order", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    const result = await provider.insert("users", {
      id: 7,
      name: "Ada",
      bio: null,
    });

    expect(sqlAt(0)).toBe(
      "INSERT INTO `users` (`id`, `name`, `bio`) VALUES (7, 'Ada', NULL)"
    );
    expect(result).toEqual({
      success: true,
      rowsAffected: 1,
      duration: expect.any(Number),
    });
  });

  it("builds UPDATE with a comma SET list and AND-joined WHERE", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 2 });

    await provider.update("users", { name: "Ada", active: true }, { id: 5 });

    expect(sqlAt(0)).toBe(
      "UPDATE `users` SET `name` = 'Ada', `active` = 1 WHERE `id` = 5"
    );
  });

  it("builds DELETE with an AND-joined WHERE", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.delete("users", { id: 5, archived: false });

    expect(sqlAt(0)).toBe(
      "DELETE FROM `users` WHERE `id` = 5 AND `archived` = 0"
    );
  });

  it("does not escape a backtick inside an identifier", async () => {
    // KNOWN DEFECT (reported): backticks in a column name are not doubled, so
    // a hostile column name escapes the quoted-identifier context.
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 1 });

    await provider.insert("t", { "a`, `b": 1 });

    expect(sqlAt(0)).toBe("INSERT INTO `t` (`a`, `b`) VALUES (1)");
  });

  it("translates write failures into failed ExecuteResults", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("Duplicate entry '1' for key"));

    await expect(provider.insert("t", { id: 1 })).resolves.toMatchObject({
      success: false,
      rowsAffected: 0,
      error: "Duplicate entry '1' for key",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ success: false });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      success: false,
    });
  });
});

describe("MySQLProvider.query / execute", () => {
  it("returns the driver rows as values and renames row_count", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({
      columns: ["a"],
      rows: [[1], [2]],
      row_count: 2,
    });

    await expect(provider.query("SELECT a FROM t")).resolves.toEqual({
      columns: ["a"],
      values: [[1], [2]],
      rowCount: 2,
      duration: expect.any(Number),
    });
  });

  it("lets a failing query reject", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("Table 'app.nope' doesn't exist"));

    await expect(provider.query("SELECT * FROM nope")).rejects.toThrow(
      "Table 'app.nope' doesn't exist"
    );
  });

  it("reports execute success with the affected row count", async () => {
    const provider = await connected();
    invokeMock.mockResolvedValue({ rows_affected: 5 });

    await expect(provider.execute("UPDATE t SET a = 1")).resolves.toEqual({
      success: true,
      rowsAffected: 5,
      duration: expect.any(Number),
    });
    expect(invokeMock).toHaveBeenCalledWith("db_sql_execute", {
      connectionId: "my-1",
      sql: "UPDATE t SET a = 1",
    });
  });

  it("translates an execute failure into a failed ExecuteResult", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue(new Error("You have an error in your SQL"));

    await expect(provider.execute("SELCT 1")).resolves.toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: "You have an error in your SQL",
    });
  });

  it("save() is a no-op for a remote database", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("MySQLProvider non-Error rejections on write paths", () => {
  it("stringifies a non-Error rejection rather than losing the reason", async () => {
    const provider = await connected();
    invokeMock.mockRejectedValue("ER_DUP_ENTRY");

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      success: false,
      error: "ER_DUP_ENTRY",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ error: "ER_DUP_ENTRY" });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      error: "ER_DUP_ENTRY",
    });
  });
});
