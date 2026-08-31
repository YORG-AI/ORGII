import { beforeEach, describe, expect, it, vi } from "vitest";

import { NeonProvider } from "../providers/NeonProvider";
import type { NeonConnectionConfig } from "../types";

const { commandCreateMock, curlExecuteMock } = vi.hoisted(() => ({
  commandCreateMock: vi.fn(),
  curlExecuteMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: { create: commandCreateMock },
}));

const CONN_STRING =
  "postgres://neondb_owner:npg_secret@ep-cool-frost-a1b2c3.us-east-2.aws.neon.tech/neondb";

const baseConfig: NeonConnectionConfig = {
  id: "neon-1",
  name: "Prod",
  type: "neon",
  createdAt: 0,
  updatedAt: 0,
  connectionString: CONN_STRING,
};

type NeonRow = {
  fields: { name: string; dataTypeID: number }[];
  rows: unknown[][];
  rowCount: number;
  command: string;
};

function neonRow(partial: Partial<NeonRow> = {}): NeonRow {
  return { fields: [], rows: [], rowCount: 0, command: "SELECT", ...partial };
}

/** A successful curl invocation carrying one Neon statement result. */
function ok(row: Partial<NeonRow> = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return {
    code: 0,
    stdout: JSON.stringify({ rows: [neonRow(row)] }),
    stderr: "",
  };
}

function raw(json: unknown): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout: JSON.stringify(json), stderr: "" };
}

function makeProvider(
  overrides: Partial<NeonConnectionConfig> = {}
): NeonProvider {
  return new NeonProvider({ ...baseConfig, ...overrides });
}

async function connected(
  overrides: Partial<NeonConnectionConfig> = {}
): Promise<NeonProvider> {
  const provider = makeProvider(overrides);
  curlExecuteMock.mockResolvedValueOnce(ok());
  await provider.connect();
  commandCreateMock.mockClear();
  curlExecuteMock.mockClear();
  return provider;
}

function argvAt(index: number): string[] {
  return commandCreateMock.mock.calls[index][1] as string[];
}

function sqlAt(index: number): string {
  const argv = argvAt(index);
  const body = JSON.parse(argv[argv.indexOf("-d") + 1]) as { query: string };
  return body.query.replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  curlExecuteMock.mockReset();
  commandCreateMock.mockReset().mockReturnValue({ execute: curlExecuteMock });
});

describe("NeonProvider connection-string parsing", () => {
  it("derives the HTTPS SQL endpoint from the host after @", async () => {
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.connect();

    expect(argvAt(0)).toContain(
      "https://ep-cool-frost-a1b2c3.us-east-2.aws.neon.tech/sql"
    );
  });

  it("rejects a connection string with no neon.tech host", () => {
    expect(() =>
      makeProvider({ connectionString: "postgres://u:p@localhost:5432/db" })
    ).toThrow("Invalid Neon connection string");
    expect(() => makeProvider({ connectionString: "" })).toThrow(
      "Invalid Neon connection string"
    );
    expect(() =>
      makeProvider({ connectionString: "postgres://u:p@neon.tech.evil/db" })
    ).toThrow("Invalid Neon connection string");
  });

  it("drops an explicit port from the derived endpoint", async () => {
    // KNOWN DEFECT (reported): the regex's second alternative
    // (`[^/]+\.neon\.tech:\d+`) is unreachable — the first alternative already
    // matches and stops before the colon — so `:5432` is silently discarded.
    const provider = makeProvider({
      connectionString: "postgres://u:p@ep-x.us-east-2.aws.neon.tech:5432/db",
    });
    curlExecuteMock.mockResolvedValue(ok());

    await provider.connect();

    expect(argvAt(0)).toContain("https://ep-x.us-east-2.aws.neon.tech/sql");
  });
});

describe("NeonProvider HTTP transport", () => {
  it("probes with SELECT 1 and passes the connection string as a header", async () => {
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.connect();

    const argv = argvAt(0);
    expect(commandCreateMock.mock.calls[0][0]).toBe("curl");
    expect(argv.slice(0, 3)).toEqual(["-s", "-X", "POST"]);
    expect(argv).toContain("Content-Type: application/json");
    expect(argv).toContain(`Neon-Connection-String: ${CONN_STRING}`);
    expect(JSON.parse(argv[argv.indexOf("-d") + 1])).toEqual({
      query: "SELECT 1 as test",
      params: [],
    });
    expect(provider.isConnected()).toBe(true);
  });

  it("turns a non-zero curl exit into a request error carrying stderr", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue({
      code: 6,
      stdout: "",
      stderr: "Could not resolve host",
    });

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      "Neon request failed: Could not resolve host"
    );
  });

  it("treats empty stdout as an empty result set", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(provider.query("SELECT 1")).resolves.toEqual({
      columns: [],
      values: [],
      rowCount: 0,
      duration: expect.any(Number),
    });
  });

  it("reports unparseable output truncated to 200 characters", async () => {
    const provider = await connected();
    const body = `<!DOCTYPE html>${"y".repeat(400)}`;
    curlExecuteMock.mockResolvedValue({ code: 0, stdout: body, stderr: "" });

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      `Invalid JSON from Neon: ${body.slice(0, 200)}`
    );
  });

  it("raises the API `message` field as the error", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      raw({ message: 'relation "nope" does not exist', code: "42P01" })
    );

    await expect(provider.query("SELECT * FROM nope")).rejects.toThrow(
      'relation "nope" does not exist'
    );
  });

  it("falls back to a generic message when `message` is present but null", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(raw({ message: null, code: "42P01" }));

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      "Unknown Neon error"
    );
  });

  it("returns an empty statement result when the response has no rows array", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(raw({ rows: [] }));

    await expect(provider.query("SELECT 1")).resolves.toEqual({
      columns: [],
      values: [],
      rowCount: 0,
      duration: expect.any(Number),
    });
  });

  it("records a connect failure on status and rethrows", async () => {
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(raw({ message: "password auth failed" }));

    await expect(provider.connect()).rejects.toThrow("password auth failed");
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({
      state: "error",
      error: "password auth failed",
    });
  });

  it("does not re-probe when already connected", async () => {
    const provider = await connected();

    await provider.connect();

    expect(commandCreateMock).not.toHaveBeenCalled();
  });

  it("disconnect is local only — no request is made", async () => {
    const provider = await connected();

    await provider.disconnect();

    expect(commandCreateMock).not.toHaveBeenCalled();
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({ state: "disconnected" });
  });
});

describe("NeonProvider connection guard", () => {
  const guarded: [string, (p: NeonProvider) => Promise<unknown>][] = [
    ["getTables", (p) => p.getTables()],
    ["getTableSchema", (p) => p.getTableSchema("users")],
    ["getTableData", (p) => p.getTableData("users")],
    ["query", (p) => p.query("SELECT 1")],
    ["insert", (p) => p.insert("users", { a: 1 })],
    ["update", (p) => p.update("users", { a: 1 }, { id: 1 })],
    ["delete", (p) => p.delete("users", { id: 1 })],
  ];

  it.each(guarded)("%s refuses to run while disconnected", async (_n, call) => {
    const provider = makeProvider();

    await expect(call(provider)).rejects.toThrow(
      "Database not connected. Call connect() first."
    );
    expect(commandCreateMock).not.toHaveBeenCalled();
  });

  it("execute() skips the guard and issues a live request while disconnected", async () => {
    // KNOWN DEFECT (reported): every other NeonProvider method — and every
    // execute() on the SQLite, Postgres, MySQL, Turso and Supabase providers —
    // calls ensureConnected() first. Neon's does not.
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(ok({ rowCount: 1 }));

    const result = await provider.execute("DELETE FROM users");

    expect(result.success).toBe(true);
    expect(commandCreateMock).toHaveBeenCalledTimes(1);
    expect(provider.isConnected()).toBe(false);
  });
});

describe("NeonProvider.getTables", () => {
  it("lists public tables and views from information_schema", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.getTables();

    // Pinned as exact SQL rather than fragments: getTables reads the result
    // rows positionally (row[0] is the name, row[1] the table_type), so the
    // projection, its `as name` alias and the ORDER BY are all contract.
    expect(sqlAt(0)).toBe(
      "SELECT table_name as name, table_type " +
        "FROM information_schema.tables " +
        "WHERE table_schema = 'public' " +
        "AND table_type IN ('BASE TABLE', 'VIEW') " +
        "ORDER BY table_name"
    );
  });

  it("maps rows positionally and attaches a row count per object", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(
        ok({
          rows: [
            ["users", "BASE TABLE"],
            ["v_users", "VIEW"],
          ],
        })
      )
      .mockResolvedValueOnce(ok({ rows: [[8]] }))
      .mockResolvedValueOnce(ok({ rows: [[8]] }));

    const tables = await provider.getTables();

    expect(sqlAt(1)).toBe('SELECT COUNT(*) as count FROM "public"."users"');
    // Dialect difference: unlike Turso, Neon also counts views.
    expect(sqlAt(2)).toBe('SELECT COUNT(*) as count FROM "public"."v_users"');
    expect(tables).toEqual([
      { name: "users", type: "table", rowCount: 8 },
      { name: "v_users", type: "view", rowCount: 8 },
    ]);
  });

  it("leaves rowCount unset when a table's COUNT fails", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(ok({ rows: [["users", "BASE TABLE"]] }))
      .mockResolvedValueOnce(raw({ message: "permission denied" }));

    await expect(provider.getTables()).resolves.toEqual([
      { name: "users", type: "table" },
    ]);
  });

  it("counts at most the first 50 tables", async () => {
    const provider = await connected();
    const listing = Array.from({ length: 60 }, (_, i) => [
      `t${i}`,
      "BASE TABLE",
    ]);
    curlExecuteMock.mockResolvedValueOnce(ok({ rows: listing }));
    curlExecuteMock.mockResolvedValue(ok({ rows: [[1]] }));

    const tables = await provider.getTables();

    expect(commandCreateMock).toHaveBeenCalledTimes(51);
    expect(tables[49].rowCount).toBe(1);
    expect(tables[50].rowCount).toBeUndefined();
  });
});

describe("NeonProvider.getTableSchema", () => {
  it("pins the exact introspection SQL, projection order included", async () => {
    // Exact SQL, not fragments: getTableSchema maps rows positionally
    // (row[0]..row[5]), so the order of the SELECT list is part of the
    // contract. Swapping `c.data_type` and `c.is_nullable`, or dropping
    // `c.udt_name`, would silently mislabel every column's type and
    // nullability in production; a fragment assertion cannot see that.
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.getTableSchema("events");

    expect(sqlAt(0)).toBe(
      "SELECT c.column_name, c.data_type, c.is_nullable, " +
        "c.column_default, c.udt_name, " +
        "CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END " +
        "as is_primary_key " +
        "FROM information_schema.columns c " +
        "LEFT JOIN ( SELECT ku.column_name " +
        "FROM information_schema.table_constraints tc " +
        "JOIN information_schema.key_column_usage ku " +
        "ON tc.constraint_name = ku.constraint_name " +
        "AND tc.table_schema = ku.table_schema " +
        "WHERE tc.constraint_type = 'PRIMARY KEY' " +
        "AND tc.table_schema = 'public' " +
        "AND tc.table_name = 'events' ) " +
        "pk ON c.column_name = pk.column_name " +
        "WHERE c.table_schema = 'public' " +
        "AND c.table_name = 'events' " +
        "ORDER BY c.ordinal_position"
    );
  });

  it("maps positional rows, preferring udt_name and detecting nextval defaults", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      ok({
        rows: [
          [
            "id",
            "integer",
            "NO",
            "nextval('users_id_seq'::regclass)",
            "int4",
            true,
          ],
          ["payload", "jsonb", "YES", null, null, false],
        ],
      })
    );

    await expect(provider.getTableSchema("users")).resolves.toEqual([
      {
        name: "id",
        type: "INT4",
        nullable: false,
        primaryKey: true,
        defaultValue: "nextval('users_id_seq'::regclass)",
        autoIncrement: true,
      },
      {
        name: "payload",
        type: "JSONB",
        nullable: true,
        primaryKey: false,
        defaultValue: null,
        autoIncrement: false,
      },
    ]);
  });

  it("accepts Postgres's 't' shorthand for a true primary-key flag", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      ok({ rows: [["id", "integer", "NO", null, "int4", "t"]] })
    );

    const [column] = await provider.getTableSchema("users");

    expect(column.primaryKey).toBe(true);
  });

  it("does not escape quotes in the table name it interpolates", async () => {
    // KNOWN DEFECT (reported): tableName lands inside a single-quoted SQL
    // literal with no escaping.
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.getTableSchema("x' OR '1'='1");

    expect(sqlAt(0)).toContain("AND c.table_name = 'x' OR '1'='1'");
  });
});

describe("NeonProvider.getTableData / query", () => {
  it("builds a schema-qualified SELECT with ORDER BY and OFFSET", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.getTableData("users", {
      page: 2,
      pageSize: 15,
      orderBy: "created_at",
      orderDirection: "desc",
    });

    expect(sqlAt(0)).toBe(
      'SELECT * FROM "public"."users" ORDER BY "created_at" DESC LIMIT 15 OFFSET 15'
    );
  });

  it("takes column names from `fields` and merges the COUNT total", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(
        ok({
          fields: [
            { name: "id", dataTypeID: 23 },
            { name: "name", dataTypeID: 25 },
          ],
          rows: [
            [1, "Ada"],
            [2, "Grace"],
          ],
        })
      )
      .mockResolvedValueOnce(ok({ rows: [[2]] }));

    const result = await provider.getTableData("users");

    expect(sqlAt(1)).toBe('SELECT COUNT(*) FROM "public"."users"');
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
  });

  it("still returns the page when the COUNT query fails", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(
        ok({ fields: [{ name: "id", dataTypeID: 23 }], rows: [[1]] })
      )
      .mockResolvedValueOnce(raw({ message: "denied" }));

    await expect(provider.getTableData("users")).resolves.toMatchObject({
      rowCount: 1,
      totalCount: undefined,
    });
  });

  it("passes user SQL through and reports rowCount from the row array", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      ok({
        fields: [{ name: "a", dataTypeID: 23 }],
        rows: [[1], [2], [3]],
        rowCount: 3,
      })
    );

    await expect(provider.query("SELECT a FROM t")).resolves.toEqual({
      columns: ["a"],
      values: [[1], [2], [3]],
      rowCount: 3,
      duration: expect.any(Number),
    });
    expect(sqlAt(0)).toBe("SELECT a FROM t");
  });

  it("lets a failing query reject", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(raw({ message: "syntax error" }));

    await expect(provider.query("SELCT 1")).rejects.toThrow("syntax error");
  });
});

describe("NeonProvider write SQL", () => {
  it("builds INSERT ... RETURNING and reads lastInsertId from the first column", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ rows: [[42, "Ada"]], rowCount: 1 }));

    const result = await provider.insert("users", {
      name: "Ada",
      active: true,
      score: 9.5,
      bio: null,
      meta: { role: "admin" },
    });

    expect(sqlAt(0)).toBe(
      'INSERT INTO "public"."users" ("name", "active", "score", "bio", "meta") ' +
        "VALUES ('Ada', TRUE, 9.5, NULL, '{\"role\":\"admin\"}'::jsonb) RETURNING *"
    );
    expect(result).toEqual({
      success: true,
      rowsAffected: 1,
      duration: expect.any(Number),
      lastInsertId: 42,
    });
  });

  it("falls back to rowsAffected 1 when the API reports rowCount 0", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ rows: [[7]], rowCount: 0 }));

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      rowsAffected: 1,
      lastInsertId: 7,
    });
  });

  it("leaves lastInsertId undefined when nothing is returned", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ rows: [], rowCount: 0 }));

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      lastInsertId: undefined,
    });
  });

  it("doubles single quotes in string literals", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.insert("users", { name: "O'Brien" });

    expect(sqlAt(0)).toContain("VALUES ('O''Brien')");
  });

  it("quotes a bigint instead of emitting it as a bare numeric literal", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok());

    await provider.insert("t", { id: 9007199254740993n });

    expect(sqlAt(0)).toContain("VALUES ('9007199254740993')");
  });

  it("builds UPDATE ... RETURNING with a comma SET list", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ rowCount: 2 }));

    const result = await provider.update(
      "users",
      { name: "Ada", active: false },
      { tenant: "acme" }
    );

    expect(sqlAt(0)).toBe(
      'UPDATE "public"."users" SET "name" = \'Ada\', "active" = FALSE ' +
        "WHERE \"tenant\" = 'acme' RETURNING *"
    );
    expect(result.rowsAffected).toBe(2);
  });

  it("builds DELETE ... RETURNING with an AND-joined predicate", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ rowCount: 1 }));

    await provider.delete("users", { id: 1, tenant: "acme" });

    expect(sqlAt(0)).toBe(
      'DELETE FROM "public"."users" WHERE "id" = 1 AND "tenant" = \'acme\' RETURNING *'
    );
  });

  it("translates write failures into failed ExecuteResults", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(raw({ message: "duplicate key" }));

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      success: false,
      rowsAffected: 0,
      error: "duplicate key",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ success: false, error: "duplicate key" });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      success: false,
      error: "duplicate key",
    });
  });

  it("reports execute failures without throwing", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(raw({ message: "deadlock detected" }));

    await expect(provider.execute("UPDATE t SET a = 1")).resolves.toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: "deadlock detected",
    });
  });

  it("save() is a no-op for a remote database", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(commandCreateMock).not.toHaveBeenCalled();
  });
});

describe("NeonProvider non-Error rejections on write paths", () => {
  it("labels a non-Error transport rejection per operation", async () => {
    const provider = await connected();
    curlExecuteMock.mockRejectedValue("spawn curl ENOENT");

    await expect(provider.insert("t", { a: 1 })).resolves.toMatchObject({
      success: false,
      error: "Insert failed",
    });
    await expect(
      provider.update("t", { a: 1 }, { id: 1 })
    ).resolves.toMatchObject({ error: "Update failed" });
    await expect(provider.delete("t", { id: 1 })).resolves.toMatchObject({
      error: "Delete failed",
    });
    await expect(provider.execute("VACUUM")).resolves.toMatchObject({
      error: "Execution failed",
    });
  });
});
