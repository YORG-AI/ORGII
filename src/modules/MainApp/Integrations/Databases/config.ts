import type { DatabaseType } from "@src/engines/DatabaseCore";

export const DATABASE_STATUS_DOT_COLOR: Record<string, string> = {
  connected: "bg-success-6",
  connecting: "bg-warning-6",
  error: "bg-danger-6",
  disabled: "bg-fill-3",
  unknown: "bg-fill-3",
};

/**
 * i18n key for a database provider's display label (e.g. "PostgreSQL",
 * "MySQL"). Use these instead of `type.charAt(0).toUpperCase()` so casing
 * matches the canonical brand spelling.
 */
export const DATABASE_PROVIDER_LABEL_KEY: Record<DatabaseType, string> = {
  sqlite: "databases.providers.sqlite",
  postgres: "databases.providers.postgres",
  mysql: "databases.providers.mysql",
  supabase: "databases.providers.supabase",
  neon: "databases.providers.neon",
  turso: "databases.providers.turso",
};
