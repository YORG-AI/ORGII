/**
 * MySQL Database Provider
 *
 * Defines MySQL-specific connection and SQL syntax while the shared
 * TauriSqlProvider owns the sqlx command lifecycle.
 */
import type { MySQLConnectionConfig } from "../types";
import { type TauriSqlDialect, TauriSqlProvider } from "./TauriSqlProvider";

function formatMySqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const MYSQL_DIALECT: TauriSqlDialect<MySQLConnectionConfig> = {
  type: "mysql",
  buildConnectionString(config) {
    const userPart = config.password
      ? `${config.user}:${config.password}`
      : config.user;
    const sslMode = config.ssl ? "REQUIRED" : "PREFERRED";
    return `mysql://${userPart}@${config.host}:${config.port}/${config.database}?ssl-mode=${sslMode}`;
  },
  quoteIdentifier(identifier) {
    return `\`${identifier}\``;
  },
  formatValue: formatMySqlValue,
};

export class MySQLProvider extends TauriSqlProvider<MySQLConnectionConfig> {
  constructor(config: MySQLConnectionConfig) {
    super(config, MYSQL_DIALECT);
  }
}

export default MySQLProvider;
