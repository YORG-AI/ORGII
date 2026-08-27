import { beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseProvider } from "../providers/SupabaseProvider";
import type { SupabaseConnectionConfig } from "../types";

const { commandCreateMock, curlExecuteMock } = vi.hoisted(() => ({
  commandCreateMock: vi.fn(),
  curlExecuteMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: { create: commandCreateMock },
}));

const baseConfig: SupabaseConnectionConfig = {
  id: "sb-1",
  name: "Prod",
  type: "supabase",
  createdAt: 0,
  updatedAt: 0,
  url: "https://abcdefghijkl.supabase.co",
  accessToken: "sbp_secret",
};

function ok(json: unknown): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout: JSON.stringify(json), stderr: "" };
}

function makeProvider(
  overrides: Partial<SupabaseConnectionConfig> = {}
): SupabaseProvider {
  return new SupabaseProvider({ ...baseConfig, ...overrides });
}

async function connected(
  overrides: Partial<SupabaseConnectionConfig> = {}
): Promise<SupabaseProvider> {
  const provider = makeProvider(overrides);
  curlExecuteMock.mockResolvedValueOnce(ok([{ test: 1 }]));
  await provider.connect();
  commandCreateMock.mockClear();
  curlExecuteMock.mockClear();
  return provider;
}

/** curl argv of the nth Command.create call. */
function argvAt(index: number): string[] {
  return commandCreateMock.mock.calls[index][1] as string[];
}

/** Whitespace-normalised SQL sent on the nth request. */
function sqlAt(index: number): string {
  const argv = argvAt(index);
  const body = JSON.parse(argv[argv.indexOf("-d") + 1]) as { query: string };
  return body.query.replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  curlExecuteMock.mockReset();
  commandCreateMock.mockReset().mockReturnValue({ execute: curlExecuteMock });
});

describe("SupabaseProvider URL parsing", () => {
  it("extracts the project ref and targets the Management API query endpoint", async () => {
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(ok([{ test: 1 }]));

    await provider.connect();

    const argv = argvAt(0);
    expect(commandCreateMock.mock.calls[0][0]).toBe("curl");
    expect(argv).toContain(
      "https://api.supabase.com/v1/projects/abcdefghijkl/database/query"
    );
  });

  it("rejects a URL that is not a supabase.co project host", () => {
    expect(() => makeProvider({ url: "https://example.com" })).toThrow(
      "Invalid Supabase URL format. Expected: https://<project-ref>.supabase.co"
    );
    expect(() => makeProvider({ url: "" })).toThrow(
      "Invalid Supabase URL format"
    );
    expect(() => makeProvider({ url: "postgres://u@h/db" })).toThrow(
      "Invalid Supabase URL format"
    );
  });

  it("accepts a supabase.co host embedded anywhere in the string", () => {
    // KNOWN DEFECT (reported): the regex is unanchored, so a pasted string that
    // merely *contains* a project URL is accepted as a valid config.
    const provider = makeProvider({
      url: "psql 'https://myref.supabase.co/rest/v1' --user postgres",
    });
    curlExecuteMock.mockResolvedValue(ok([]));

    return provider.connect().then(() => {
      expect(argvAt(0)).toContain(
        "https://api.supabase.com/v1/projects/myref/database/query"
      );
    });
  });

  it("defaults the schema to public and honours an explicit schema", async () => {
    const defaultSchema = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));
    await defaultSchema.getTableData("users");
    expect(sqlAt(0)).toContain('FROM "public"."users"');

    commandCreateMock.mockClear();
    const custom = await connected({ schema: "analytics" });
    curlExecuteMock.mockResolvedValue(ok([]));
    await custom.getTableData("events");
    expect(sqlAt(0)).toContain('FROM "analytics"."events"');
  });
});

describe("SupabaseProvider HTTP transport", () => {
  it("sends a bearer token and a JSON body over curl -s -X POST", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.query("SELECT 1");

    const argv = argvAt(0);
    expect(argv[0]).toBe("-s");
    expect(argv[1]).toBe("-X");
    expect(argv[2]).toBe("POST");
    expect(argv).toContain("Content-Type: application/json");
    expect(argv).toContain("Authorization: Bearer sbp_secret");
    expect(JSON.parse(argv[argv.indexOf("-d") + 1])).toEqual({
      query: "SELECT 1",
    });
  });

  it("turns a non-zero curl exit into a request error carrying stderr", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue({
      code: 7,
      stdout: "",
      stderr: "Failed to connect to api.supabase.com port 443",
    });

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      "Request failed: Failed to connect to api.supabase.com port 443"
    );
  });

  it("treats empty stdout as an empty result set", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue({ code: 0, stdout: "   ", stderr: "" });

    await expect(provider.query("SELECT 1")).resolves.toEqual({
      columns: [],
      values: [],
      rowCount: 0,
      duration: expect.any(Number),
    });
  });

  it("reports unparseable output and truncates it to 200 characters", async () => {
    const provider = await connected();
    const html = `<html>${"x".repeat(400)}</html>`;
    curlExecuteMock.mockResolvedValue({ code: 0, stdout: html, stderr: "" });

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      `Invalid JSON response: ${html.slice(0, 200)}`
    );
  });

  it("raises the API message and appends the hint when present", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      ok({
        message: 'relation "nope" does not exist',
        hint: "Perhaps you meant nope_v2",
      })
    );

    await expect(provider.query("SELECT * FROM nope")).rejects.toThrow(
      'relation "nope" does not exist (Perhaps you meant nope_v2)'
    );
  });

  it("falls back to the `error` field when there is no `message`", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ error: "unauthorized" }));

    await expect(provider.query("SELECT 1")).rejects.toThrow("unauthorized");
  });

  it("records a connect failure on status and rethrows", async () => {
    const provider = makeProvider();
    curlExecuteMock.mockResolvedValue(ok({ message: "Invalid access token" }));

    await expect(provider.connect()).rejects.toThrow("Invalid access token");
    expect(provider.isConnected()).toBe(false);
    expect(provider.status).toEqual({
      state: "error",
      error: "Invalid access token",
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

describe("SupabaseProvider requires a connection", () => {
  const calls: [string, (p: SupabaseProvider) => Promise<unknown>][] = [
    ["getTables", (p) => p.getTables()],
    ["getTableSchema", (p) => p.getTableSchema("users")],
    ["getTableData", (p) => p.getTableData("users")],
    ["query", (p) => p.query("SELECT 1")],
    ["insert", (p) => p.insert("users", { a: 1 })],
    ["update", (p) => p.update("users", { a: 1 }, { id: 1 })],
    ["delete", (p) => p.delete("users", { id: 1 })],
  ];

  it.each(calls)("%s refuses to run while disconnected", async (_n, call) => {
    const provider = makeProvider();

    await expect(call(provider)).rejects.toThrow(
      "Database not connected. Call connect() first."
    );
    expect(commandCreateMock).not.toHaveBeenCalled();
  });

  it("execute inherits the guard through query() and reports it as a failure", async () => {
    const provider = makeProvider();

    await expect(provider.execute("VACUUM")).resolves.toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: "Database not connected. Call connect() first.",
    });
    expect(commandCreateMock).not.toHaveBeenCalled();
  });
});

describe("SupabaseProvider.getTables", () => {
  it("filters information_schema.tables by the configured schema", async () => {
    const provider = await connected({ schema: "analytics" });
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.getTables();

    // Pinned as exact SQL rather than fragments: the mapper below reads
    // `row.name`, so the `table_name as name` alias is contract, not cosmetic.
    expect(sqlAt(0)).toBe(
      "SELECT table_name as name, table_type " +
        "FROM information_schema.tables " +
        "WHERE table_schema = 'analytics' " +
        "AND table_type IN ('BASE TABLE', 'VIEW') " +
        "ORDER BY table_name"
    );
  });

  it("maps table_type and attaches per-table row counts", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(
        ok([
          { name: "users", table_type: "BASE TABLE" },
          { name: "v_users", table_type: "VIEW" },
        ])
      )
      .mockResolvedValueOnce(ok([{ count: 11 }]))
      .mockResolvedValueOnce(ok([{ count: 11 }]));

    const tables = await provider.getTables();

    expect(sqlAt(1)).toBe('SELECT COUNT(*) as count FROM "public"."users"');
    expect(tables).toEqual([
      { name: "users", type: "table", rowCount: 11 },
      { name: "v_users", type: "view", rowCount: 11 },
    ]);
  });

  it("leaves rowCount unset when a table's COUNT fails", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(ok([{ name: "users", table_type: "BASE TABLE" }]))
      .mockResolvedValueOnce(ok({ message: "permission denied" }));

    await expect(provider.getTables()).resolves.toEqual([
      { name: "users", type: "table" },
    ]);
  });

  it("counts at most the first 50 tables", async () => {
    const provider = await connected();
    const listing = Array.from({ length: 60 }, (_, i) => ({
      name: `t${i}`,
      table_type: "BASE TABLE",
    }));
    curlExecuteMock.mockResolvedValueOnce(ok(listing));
    curlExecuteMock.mockResolvedValue(ok([{ count: 1 }]));

    const tables = await provider.getTables();

    // 1 listing request + 50 count requests.
    expect(commandCreateMock).toHaveBeenCalledTimes(51);
    expect(tables[49].rowCount).toBe(1);
    expect(tables[50].rowCount).toBeUndefined();
  });
});

describe("SupabaseProvider.getTableSchema", () => {
  it("scopes both the column and primary-key lookups to schema and table", async () => {
    const provider = await connected({ schema: "analytics" });
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.getTableSchema("events");

    // Pinned as exact SQL rather than fragments: the mapper reads the rows by
    // name (`row.column_name`, `row.udt_name`, ...), so every column in the
    // SELECT list — and every alias on it — is contract.
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
        "AND tc.table_schema = 'analytics' " +
        "AND tc.table_name = 'events' ) " +
        "pk ON c.column_name = pk.column_name " +
        "WHERE c.table_schema = 'analytics' " +
        "AND c.table_name = 'events' " +
        "ORDER BY c.ordinal_position"
    );
  });

  it("prefers udt_name over data_type and upper-cases it", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(
      ok([
        {
          column_name: "id",
          data_type: "integer",
          udt_name: "int4",
          is_nullable: "NO",
          column_default: "nextval('users_id_seq'::regclass)",
          is_primary_key: true,
        },
        {
          column_name: "payload",
          data_type: "jsonb",
          udt_name: null,
          is_nullable: "YES",
          column_default: null,
          is_primary_key: false,
        },
      ])
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

  it("does not escape quotes in the table name it interpolates", async () => {
    // KNOWN DEFECT (reported): tableName lands inside a single-quoted SQL
    // literal with no escaping, so an apostrophe breaks (or rewrites) the query.
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.getTableSchema("x' OR '1'='1");

    expect(sqlAt(0)).toContain("AND c.table_name = 'x' OR '1'='1'");
  });
});

describe("SupabaseProvider.getTableData", () => {
  it("builds a schema-qualified SELECT with LIMIT/OFFSET", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.getTableData("users", {
      page: 3,
      pageSize: 20,
      orderBy: "created_at",
      orderDirection: "desc",
    });

    expect(sqlAt(0)).toBe(
      'SELECT * FROM "public"."users" ORDER BY "created_at" DESC LIMIT 20 OFFSET 40'
    );
  });

  it("derives columns from the first row and returns positional values", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(
        ok([
          { id: 1, name: "Ada" },
          { id: 2, name: "Grace" },
        ])
      )
      .mockResolvedValueOnce(ok([{ count: 2 }]));

    await expect(provider.getTableData("users")).resolves.toEqual({
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

  it("returns totalCount 0 for an empty page whose COUNT also failed", async () => {
    const provider = await connected();
    curlExecuteMock
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ message: "denied" }));

    await expect(provider.getTableData("users")).resolves.toEqual({
      columns: [],
      values: [],
      rowCount: 0,
      totalCount: 0,
      duration: expect.any(Number),
    });
  });
});

describe("SupabaseProvider.query / execute", () => {
  it("returns columns from the first row and rowCount from the row array", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([{ a: 1, b: "x" }]));

    await expect(provider.query("SELECT a, b FROM t")).resolves.toEqual({
      columns: ["a", "b"],
      values: [[1, "x"]],
      rowCount: 1,
      duration: expect.any(Number),
    });
  });

  it("reports execute success with the returned row count", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([{ id: 1 }, { id: 2 }]));

    await expect(
      provider.execute("DELETE FROM t RETURNING id")
    ).resolves.toEqual({
      success: true,
      rowsAffected: 2,
      duration: expect.any(Number),
    });
  });

  it("translates an API error into a failed ExecuteResult", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ message: "syntax error" }));

    await expect(provider.execute("SELCT 1")).resolves.toEqual({
      success: false,
      rowsAffected: 0,
      duration: expect.any(Number),
      error: "syntax error",
    });
  });
});

describe("SupabaseProvider write SQL", () => {
  it("builds a schema-qualified INSERT ... RETURNING with typed literals", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([{ id: 42 }]));

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

  it("doubles single quotes in string literals", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.insert("users", { name: "O'Brien" });

    expect(sqlAt(0)).toContain("VALUES ('O''Brien')");
  });

  it("quotes a bigint instead of emitting it as a bare numeric literal", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([]));

    await provider.insert("t", { id: 9007199254740993n });

    expect(sqlAt(0)).toContain("VALUES ('9007199254740993')");
  });

  it("builds UPDATE ... RETURNING and counts the returned rows", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok([{ id: 1 }, { id: 2 }]));

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
    curlExecuteMock.mockResolvedValue(ok([{ id: 1 }]));

    await provider.delete("users", { id: 1, tenant: "acme" });

    expect(sqlAt(0)).toBe(
      'DELETE FROM "public"."users" WHERE "id" = 1 AND "tenant" = \'acme\' RETURNING *'
    );
  });

  it("translates write failures into failed ExecuteResults", async () => {
    const provider = await connected();
    curlExecuteMock.mockResolvedValue(ok({ message: "duplicate key" }));

    await expect(provider.insert("t", { id: 1 })).resolves.toMatchObject({
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

  it("save() is a no-op for a remote database", async () => {
    const provider = await connected();

    await expect(provider.save()).resolves.toBeUndefined();
    expect(commandCreateMock).not.toHaveBeenCalled();
  });
});

describe("SupabaseProvider non-Error rejections on write paths", () => {
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
