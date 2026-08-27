/**
 * Public-surface tests for the two DatabaseCore barrels.
 *
 * These pin what the engine promises to its consumers (WorkStation UI,
 * Integrations, agent tools) so a re-export cannot be dropped or renamed
 * without a failing test.
 */
import { describe, expect, it, vi } from "vitest";

import * as databaseCore from "../index";
import { MySQLProvider } from "../providers/MySQLProvider";
import { NeonProvider } from "../providers/NeonProvider";
import { PostgresProvider } from "../providers/PostgresProvider";
import { SupabaseProvider } from "../providers/SupabaseProvider";
import { TauriSqliteProvider } from "../providers/TauriSqliteProvider";
import { TursoProvider } from "../providers/TursoProvider";
import * as providers from "../providers/index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ Command: { create: vi.fn() } }));
vi.mock("@libsql/client", () => ({ createClient: vi.fn() }));

describe("DatabaseCore public barrel", () => {
  it("exports the factory, the sqlite validator and every type guard", () => {
    expect(Object.keys(databaseCore).sort()).toEqual([
      "DATABASE_TYPES",
      "DatabaseServiceFactory",
      "getConnectionPath",
      "isMySQLConfig",
      "isNeonConfig",
      "isPostgresConfig",
      "isSqliteConfig",
      "isSupabaseConfig",
      "isTursoConfig",
      "isValidSqliteFile",
    ]);
  });

  it("re-exports DATABASE_TYPES in the order the UI renders them", () => {
    expect(databaseCore.DATABASE_TYPES).toEqual([
      "sqlite",
      "supabase",
      "turso",
      "neon",
      "postgres",
      "mysql",
    ]);
  });

  it("keeps provider classes out of the public barrel — they are lazy-loaded", () => {
    expect(databaseCore).not.toHaveProperty("SqliteProvider");
    expect(databaseCore).not.toHaveProperty("PostgresProvider");
  });
});

describe("providers barrel", () => {
  it("exposes one class per DatabaseType plus the sqlite validator", () => {
    expect(Object.keys(providers).sort()).toEqual([
      "MySQLProvider",
      "NeonProvider",
      "PostgresProvider",
      "SqliteProvider",
      "SupabaseProvider",
      "TursoProvider",
      "isValidSqliteFile",
    ]);
  });

  it("aliases SqliteProvider to TauriSqliteProvider", () => {
    expect(providers.SqliteProvider).toBe(TauriSqliteProvider);
  });

  it("re-exports the remaining provider classes unaliased", () => {
    expect(providers.SupabaseProvider).toBe(SupabaseProvider);
    expect(providers.TursoProvider).toBe(TursoProvider);
    expect(providers.NeonProvider).toBe(NeonProvider);
    expect(providers.PostgresProvider).toBe(PostgresProvider);
    expect(providers.MySQLProvider).toBe(MySQLProvider);
  });
});
