import { invoke } from "@tauri-apps/api/core";

import type {
  MySQLConnectionConfig,
  PostgresConnectionConfig,
} from "../../types";
import { MySQLProvider } from "../MySQLProvider";
import { PostgresProvider } from "../PostgresProvider";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

const baseConfig = {
  name: "Test database",
  createdAt: 1,
  updatedAt: 1,
} as const;

const postgresConfig: PostgresConnectionConfig = {
  ...baseConfig,
  id: "postgres-1",
  type: "postgres",
  host: "postgres.example.com",
  port: 5432,
  database: "app",
  user: "developer",
  password: "secret",
  ssl: true,
};

const mysqlConfig: MySQLConnectionConfig = {
  ...baseConfig,
  id: "mysql-1",
  type: "mysql",
  host: "mysql.example.com",
  port: 3306,
  database: "app",
  user: "root",
  ssl: false,
};

function sqlCalls(): string[] {
  return invokeMock.mock.calls
    .filter(
      ([command]) => command === "db_sql_query" || command === "db_sql_execute"
    )
    .map(([, args]) => (args as { sql: string }).sql);
}

describe("TauriSqlProvider", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation(async (command) => {
      switch (command) {
        case "db_sql_query":
          return { columns: ["id"], rows: [[1]], row_count: 1 };
        case "db_sql_execute":
          return { rows_affected: 2 };
        case "db_sql_get_tables":
          return [
            { name: "users", table_type: "BASE TABLE", row_count: 4 },
            { name: "active_users", table_type: "VIEW", row_count: null },
          ];
        case "db_sql_get_table_schema":
          return [
            {
              name: "id",
              data_type: "integer",
              nullable: false,
              primary_key: true,
              default_value: null,
              auto_increment: true,
            },
          ];
        default:
          return undefined;
      }
    });
  });

  it("connects each provider with its unchanged database type and connection string", async () => {
    const postgres = new PostgresProvider(postgresConfig);
    const mysql = new MySQLProvider(mysqlConfig);

    await postgres.connect();
    await mysql.connect();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "db_sql_connect", {
      connectionId: "postgres-1",
      dbType: "postgres",
      connectionString:
        "postgres://developer:secret@postgres.example.com:5432/app?sslmode=require",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "db_sql_connect", {
      connectionId: "mysql-1",
      dbType: "mysql",
      connectionString:
        "mysql://root@mysql.example.com:3306/app?ssl-mode=PREFERRED",
    });
    expect(postgres.status.state).toBe("connected");
    expect(mysql.isConnected()).toBe(true);
  });

  it.each([
    {
      name: "PostgreSQL",
      provider: () => new PostgresProvider(postgresConfig),
      expected: [
        'SELECT * FROM "users" ORDER BY "created_at" DESC LIMIT 25 OFFSET 25',
        'SELECT COUNT(*) as count FROM "users"',
      ],
    },
    {
      name: "MySQL",
      provider: () => new MySQLProvider(mysqlConfig),
      expected: [
        "SELECT * FROM `users` ORDER BY `created_at` DESC LIMIT 25 OFFSET 25",
        "SELECT COUNT(*) as count FROM `users`",
      ],
    },
  ])(
    "keeps $name pagination and identifier syntax",
    async ({ provider, expected }) => {
      const service = provider();
      await service.connect();

      const result = await service.getTableData("users", {
        page: 2,
        pageSize: 25,
        orderBy: "created_at",
        orderDirection: "desc",
      });

      expect(sqlCalls()).toEqual(expected);
      expect(result).toMatchObject({
        columns: ["id"],
        values: [[1]],
        rowCount: 1,
        totalCount: 1,
      });
    }
  );

  it("keeps PostgreSQL value formatting in shared CRUD commands", async () => {
    const provider = new PostgresProvider(postgresConfig);
    await provider.connect();

    await provider.insert("events", {
      enabled: true,
      payload: { label: "it's ready" },
    });
    await provider.update("events", { enabled: false }, { id: 3 });
    await provider.delete("events", { id: 3 });

    expect(sqlCalls()).toEqual([
      expect.stringContaining(
        'INSERT INTO "events" ("enabled", "payload")\n      VALUES (TRUE, \'{"label":"it\'\'s ready"}\'::jsonb)'
      ),
      'UPDATE "events" SET "enabled" = FALSE WHERE "id" = 3',
      'DELETE FROM "events" WHERE "id" = 3',
    ]);
  });

  it("keeps MySQL value formatting in shared CRUD commands", async () => {
    const provider = new MySQLProvider(mysqlConfig);
    await provider.connect();

    await provider.insert("events", {
      enabled: true,
      payload: { label: "it's ready" },
    });
    await provider.update("events", { enabled: false }, { id: 3 });
    await provider.delete("events", { id: 3 });

    expect(sqlCalls()).toEqual([
      expect.stringContaining(
        "INSERT INTO `events` (`enabled`, `payload`)\n      VALUES (1, '{\"label\":\"it''s ready\"}')"
      ),
      "UPDATE `events` SET `enabled` = 0 WHERE `id` = 3",
      "DELETE FROM `events` WHERE `id` = 3",
    ]);
  });

  it("maps shared table metadata and resets state after a failed disconnect", async () => {
    const provider = new PostgresProvider(postgresConfig);
    await provider.connect();

    await expect(provider.getTables()).resolves.toEqual([
      { name: "users", type: "table", rowCount: 4 },
      { name: "active_users", type: "view", rowCount: undefined },
    ]);
    await expect(provider.getTableSchema("users")).resolves.toEqual([
      {
        name: "id",
        type: "integer",
        nullable: false,
        primaryKey: true,
        defaultValue: null,
        autoIncrement: true,
      },
    ]);

    invokeMock.mockRejectedValueOnce(new Error("already closed"));
    await provider.disconnect();

    expect(provider.status).toEqual({ state: "disconnected" });
    expect(provider.isConnected()).toBe(false);
  });

  it("rejects commands before connection and records connect failures", async () => {
    const provider = new MySQLProvider(mysqlConfig);

    await expect(provider.query("SELECT 1")).rejects.toThrow(
      "Database not connected"
    );
    invokeMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(provider.connect()).rejects.toThrow("connection refused");
    expect(provider.status).toEqual({
      state: "error",
      error: "connection refused",
    });
  });
});
