import type { DatabaseConnectionConfig } from "../types";
import {
  getConnectionPath,
  isMySQLConfig,
  isNeonConfig,
  isPostgresConfig,
  isSqliteConfig,
  isSupabaseConfig,
  isTursoConfig,
} from "../types";

const base = {
  id: "id-1",
  name: "Test",
  createdAt: 0,
  updatedAt: 0,
} as const;

const sqliteConfig: DatabaseConnectionConfig = {
  ...base,
  type: "sqlite",
  filePath: "/data/app.db",
};

const supabaseConfig: DatabaseConnectionConfig = {
  ...base,
  type: "supabase",
  url: "https://xyz.supabase.co",
  accessToken: "token",
};

const tursoConfig: DatabaseConnectionConfig = {
  ...base,
  type: "turso",
  url: "libsql://example.turso.io",
};

const neonConfig: DatabaseConnectionConfig = {
  ...base,
  type: "neon",
  connectionString: "postgres://user:pass@neon.tech/db",
};

const postgresConfig: DatabaseConnectionConfig = {
  ...base,
  type: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "mydb",
  user: "u",
};

const mysqlConfig: DatabaseConnectionConfig = {
  ...base,
  type: "mysql",
  host: "mysql.example.com",
  port: 3306,
  database: "app",
  user: "root",
};

const allConfigs: DatabaseConnectionConfig[] = [
  sqliteConfig,
  supabaseConfig,
  tursoConfig,
  neonConfig,
  postgresConfig,
  mysqlConfig,
];

describe("DatabaseConnectionConfig type guards", () => {
  it("isSqliteConfig is true only for sqlite", () => {
    for (const config of allConfigs) {
      expect(isSqliteConfig(config)).toBe(config.type === "sqlite");
    }
  });

  it("isSupabaseConfig is true only for supabase", () => {
    for (const config of allConfigs) {
      expect(isSupabaseConfig(config)).toBe(config.type === "supabase");
    }
  });

  it("isTursoConfig is true only for turso", () => {
    for (const config of allConfigs) {
      expect(isTursoConfig(config)).toBe(config.type === "turso");
    }
  });

  it("isNeonConfig is true only for neon", () => {
    for (const config of allConfigs) {
      expect(isNeonConfig(config)).toBe(config.type === "neon");
    }
  });

  it("isPostgresConfig is true only for postgres", () => {
    for (const config of allConfigs) {
      expect(isPostgresConfig(config)).toBe(config.type === "postgres");
    }
  });

  it("isMySQLConfig is true only for mysql", () => {
    for (const config of allConfigs) {
      expect(isMySQLConfig(config)).toBe(config.type === "mysql");
    }
  });
});

describe("getConnectionPath", () => {
  it("returns sqlite filePath", () => {
    expect(getConnectionPath(sqliteConfig)).toBe("/data/app.db");
  });

  it("returns supabase url", () => {
    expect(getConnectionPath(supabaseConfig)).toBe("https://xyz.supabase.co");
  });

  it("returns turso url", () => {
    expect(getConnectionPath(tursoConfig)).toBe("libsql://example.turso.io");
  });

  it("returns neon connectionString", () => {
    expect(getConnectionPath(neonConfig)).toBe(
      "postgres://user:pass@neon.tech/db"
    );
  });

  it("returns host:port/database for postgres", () => {
    expect(getConnectionPath(postgresConfig)).toBe("db.example.com:5432/mydb");
  });

  it("returns host:port/database for mysql", () => {
    expect(getConnectionPath(mysqlConfig)).toBe("mysql.example.com:3306/app");
  });

  it("returns an empty string for a type outside DatabaseType", () => {
    const unknownConfig = {
      ...base,
      type: "cassandra",
    } as unknown as DatabaseConnectionConfig;

    expect(getConnectionPath(unknownConfig)).toBe("");
  });
});
