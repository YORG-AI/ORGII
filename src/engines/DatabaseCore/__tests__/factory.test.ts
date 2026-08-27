/**
 * Tests for the DatabaseServiceFactory.
 *
 * Only the driver boundary is mocked (`@tauri-apps/api/core`,
 * `@tauri-apps/plugin-shell`, `@libsql/client`); the factory constructs the
 * *real* provider classes so provider selection is verified end to end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseServiceFactory } from "../factory";
import type {
  DatabaseConnectionConfig,
  MySQLConnectionConfig,
  NeonConnectionConfig,
  PostgresConnectionConfig,
  SqliteConnectionConfig,
  SupabaseConnectionConfig,
  TursoConnectionConfig,
} from "../types";

const { invokeMock, commandCreateMock, createClientMock, loggerError } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    commandCreateMock: vi.fn(),
    createClientMock: vi.fn(),
    loggerError: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@tauri-apps/plugin-shell", () => ({
  Command: { create: commandCreateMock },
}));

vi.mock("@libsql/client", () => ({ createClient: createClientMock }));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const base = { name: "Test", createdAt: 0, updatedAt: 0 } as const;

function sqlite(id: string): SqliteConnectionConfig {
  return { ...base, id, type: "sqlite", filePath: `/tmp/${id}.db` };
}

const supabase: SupabaseConnectionConfig = {
  ...base,
  id: "supabase-1",
  type: "supabase",
  url: "https://abcdefg.supabase.co",
  accessToken: "sbp_token",
};

const turso: TursoConnectionConfig = {
  ...base,
  id: "turso-1",
  type: "turso",
  url: "libsql://db.turso.io",
  authToken: "tok",
};

const neon: NeonConnectionConfig = {
  ...base,
  id: "neon-1",
  type: "neon",
  connectionString: "postgres://u:p@ep-cool-1.us-east-2.aws.neon.tech/main",
};

const postgres: PostgresConnectionConfig = {
  ...base,
  id: "pg-1",
  type: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "app",
  user: "u",
};

const mysql: MySQLConnectionConfig = {
  ...base,
  id: "my-1",
  type: "mysql",
  host: "mysql.example.com",
  port: 3306,
  database: "app",
  user: "root",
};

beforeEach(async () => {
  await DatabaseServiceFactory.clearAll();
  invokeMock.mockReset().mockResolvedValue("conn-token");
  commandCreateMock.mockReset().mockReturnValue({
    execute: vi.fn().mockResolvedValue({ code: 0, stdout: "[]", stderr: "" }),
  });
  createClientMock.mockReset().mockReturnValue({
    execute: vi.fn().mockResolvedValue({
      columns: [],
      rows: [],
      rowsAffected: 0,
      lastInsertRowid: undefined,
    }),
    close: vi.fn(),
  });
  loggerError.mockReset();
});

describe("DatabaseServiceFactory.create — provider selection", () => {
  it.each([
    ["sqlite", () => sqlite("sqlite-1")],
    ["supabase", () => supabase],
    ["turso", () => turso],
    ["neon", () => neon],
    ["postgres", () => postgres],
    ["mysql", () => mysql],
  ] as const)(
    "builds a %s provider whose type and config match the request",
    async (expectedType, makeConfig) => {
      const config = makeConfig() as DatabaseConnectionConfig;
      const service = await DatabaseServiceFactory.create(config);

      expect(service.type).toBe(expectedType);
      expect(service.config).toBe(config);
      expect(service.status).toEqual({ state: "disconnected" });
      expect(service.isConnected()).toBe(false);
    }
  );

  it("rejects an unknown database type without caching anything", async () => {
    const bogus = {
      ...base,
      id: "bogus-1",
      type: "cassandra",
    } as unknown as DatabaseConnectionConfig;

    await expect(DatabaseServiceFactory.create(bogus)).rejects.toThrow(
      "Unsupported database type: cassandra"
    );
    expect(DatabaseServiceFactory.has("bogus-1")).toBe(false);
    expect(DatabaseServiceFactory.getConnectionIds()).toEqual([]);
  });

  it("returns the identical instance for a repeated id", async () => {
    const config = sqlite("cache-me");
    const first = await DatabaseServiceFactory.create(config);
    const second = await DatabaseServiceFactory.create(config);

    expect(second).toBe(first);
    expect(DatabaseServiceFactory.getAllServices()).toHaveLength(1);
  });

  it("forceNew replaces the cached instance rather than adding a second", async () => {
    const config = sqlite("force-me");
    const first = await DatabaseServiceFactory.create(config);
    const second = await DatabaseServiceFactory.create(config, true);

    expect(second).not.toBe(first);
    expect(DatabaseServiceFactory.get("force-me")).toBe(second);
    expect(DatabaseServiceFactory.getConnectionIds()).toEqual(["force-me"]);
  });
});

describe("DatabaseServiceFactory cache eviction", () => {
  it("evicts the oldest entry once 50 services are cached and disconnects it", async () => {
    const oldest = await DatabaseServiceFactory.create(sqlite("evict-0"));
    await oldest.connect();
    expect(oldest.isConnected()).toBe(true);

    for (let i = 1; i < 50; i += 1) {
      await DatabaseServiceFactory.create(sqlite(`evict-${i}`));
    }
    expect(DatabaseServiceFactory.getConnectionIds()).toHaveLength(50);
    expect(DatabaseServiceFactory.has("evict-0")).toBe(true);

    invokeMock.mockClear();
    await DatabaseServiceFactory.create(sqlite("evict-50"));

    expect(DatabaseServiceFactory.has("evict-0")).toBe(false);
    expect(DatabaseServiceFactory.has("evict-50")).toBe(true);
    expect(DatabaseServiceFactory.getConnectionIds()).toHaveLength(50);
    expect(invokeMock).toHaveBeenCalledWith("db_close", {
      connectionId: "conn-token",
    });
  });

  it("does not attempt to disconnect an evicted service that never connected", async () => {
    for (let i = 0; i < 50; i += 1) {
      await DatabaseServiceFactory.create(sqlite(`idle-${i}`));
    }

    invokeMock.mockClear();
    await DatabaseServiceFactory.create(sqlite("idle-50"));

    expect(DatabaseServiceFactory.has("idle-0")).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("DatabaseServiceFactory.getOrReconnect", () => {
  it("returns a cached, already-connected service without reconnecting", async () => {
    const service = await DatabaseServiceFactory.create(sqlite("live"));
    await service.connect();
    invokeMock.mockClear();

    const loader = vi.fn(() => [] as DatabaseConnectionConfig[]);
    const result = await DatabaseServiceFactory.getOrReconnect("live", loader);

    expect(result).toBe(service);
    expect(loader).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reconnects a cached but disconnected service", async () => {
    const service = await DatabaseServiceFactory.create(sqlite("stale"));
    expect(service.isConnected()).toBe(false);

    const loader = vi.fn(() => [] as DatabaseConnectionConfig[]);
    const result = await DatabaseServiceFactory.getOrReconnect("stale", loader);

    expect(result).toBe(service);
    expect(result!.isConnected()).toBe(true);
    expect(loader).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("db_open", {
      filePath: "/tmp/stale.db",
    });
  });

  it("creates and connects from the loader when nothing is cached", async () => {
    const config = sqlite("cold");
    const loader = vi.fn(() => [sqlite("other"), config]);

    const result = await DatabaseServiceFactory.getOrReconnect("cold", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result?.config).toBe(config);
    expect(result?.isConnected()).toBe(true);
    expect(DatabaseServiceFactory.has("cold")).toBe(true);
  });

  it("returns undefined when the loader has no config for the id", async () => {
    const loader = vi.fn(() => [sqlite("someone-else")]);

    const result = await DatabaseServiceFactory.getOrReconnect(
      "missing",
      loader
    );

    expect(result).toBeUndefined();
    expect(DatabaseServiceFactory.has("missing")).toBe(false);
  });

  it("propagates a connect failure instead of returning a half-open service", async () => {
    invokeMock.mockRejectedValueOnce(new Error("file locked"));
    const loader = vi.fn(() => [sqlite("broken")]);

    await expect(
      DatabaseServiceFactory.getOrReconnect("broken", loader)
    ).rejects.toThrow("file locked");

    // The instance is still cached, but reports its failure honestly.
    const cached = DatabaseServiceFactory.get("broken");
    expect(cached?.isConnected()).toBe(false);
    expect(cached?.status).toEqual({ state: "error", error: "file locked" });
  });
});

describe("DatabaseServiceFactory.remove / clearAll", () => {
  it("removes a cached service and closes its connection", async () => {
    const service = await DatabaseServiceFactory.create(sqlite("bye"));
    await service.connect();
    invokeMock.mockClear();

    expect(DatabaseServiceFactory.remove("bye")).toBe(true);
    expect(DatabaseServiceFactory.has("bye")).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("db_close", {
      connectionId: "conn-token",
    });
  });

  it("returns false for an id that was never cached", () => {
    expect(DatabaseServiceFactory.remove("never-existed")).toBe(false);
  });

  it("clearAll disconnects every connected service and empties the cache", async () => {
    const a = await DatabaseServiceFactory.create(sqlite("a"));
    const b = await DatabaseServiceFactory.create(sqlite("b"));
    await a.connect();
    await b.connect();
    invokeMock.mockClear();

    await DatabaseServiceFactory.clearAll();

    expect(DatabaseServiceFactory.getConnectionIds()).toEqual([]);
    expect(DatabaseServiceFactory.getAllServices()).toEqual([]);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "db_close")
    ).toHaveLength(2);
  });

  it("clearAll still empties the cache when a disconnect rejects", async () => {
    const service = await DatabaseServiceFactory.create(sqlite("flaky"));
    await service.connect();
    invokeMock.mockRejectedValue(new Error("close failed"));

    await expect(DatabaseServiceFactory.clearAll()).resolves.toBeUndefined();
    expect(DatabaseServiceFactory.getConnectionIds()).toEqual([]);
  });
});
