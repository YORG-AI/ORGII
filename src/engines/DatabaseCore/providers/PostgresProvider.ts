/**
 * PostgreSQL Database Provider
 *
 * Defines PostgreSQL-specific connection and SQL syntax while the shared
 * TauriSqlProvider owns the sqlx command lifecycle.
 */
import type { PostgresConnectionConfig } from "../types";
import { type TauriSqlDialect, TauriSqlProvider } from "./TauriSqlProvider";

function formatPostgresValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const POSTGRES_DIALECT: TauriSqlDialect<PostgresConnectionConfig> = {
  type: "postgres",
  buildConnectionString(config) {
    const userPart = config.password
      ? `${config.user}:${config.password}`
      : config.user;
    const sslMode = config.ssl ? "require" : "prefer";
    return `postgres://${userPart}@${config.host}:${config.port}/${config.database}?sslmode=${sslMode}`;
  },
  quoteIdentifier(identifier) {
    return `"${identifier}"`;
  },
  formatValue: formatPostgresValue,
};

export class PostgresProvider extends TauriSqlProvider<PostgresConnectionConfig> {
  constructor(config: PostgresConnectionConfig) {
    super(config, POSTGRES_DIALECT);
  }
}

export default PostgresProvider;
