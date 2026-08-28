import React, { memo } from "react";

import type { DatabaseType } from "@src/engines/DatabaseCore";
import { DatabaseIcon as Database, HugeiconsIcon } from "@src/icons";

import MongoIcon from "./mongo.svg";
import MySQLIcon from "./mysql.svg";
import NeonIcon from "./neon.svg";
import PostgresIcon from "./postgres.svg";
import RedisIcon from "./redis.svg";
import SQLiteIcon from "./sqlite.svg";
import SupabaseIcon from "./supabase.svg";
import TursoIcon from "./turso.svg";

export {
  MongoIcon,
  MySQLIcon,
  NeonIcon,
  PostgresIcon,
  RedisIcon,
  SQLiteIcon,
  SupabaseIcon,
  TursoIcon,
};

/** Maps DB CLI binary names to icon types for DbClientIcon */
const DB_CLIENT_BINARY_TO_ICON: Record<
  string,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  sqlite3: SQLiteIcon,
  mysql: MySQLIcon,
  psql: PostgresIcon,
  "redis-cli": RedisIcon,
  mongosh: MongoIcon,
};

export interface DatabaseIconProps {
  type: DatabaseType;
  size?: "small" | "medium" | "large" | number;
  className?: string;
}

const SIZE_MAP: Record<string, number> = {
  small: 14,
  medium: 20,
  large: 28,
};

const ICON_MAP: Record<
  DatabaseType,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  sqlite: SQLiteIcon,
  postgres: PostgresIcon,
  mysql: MySQLIcon,
  supabase: SupabaseIcon,
  neon: NeonIcon,
  turso: TursoIcon,
};

export const DatabaseIcon: React.FC<DatabaseIconProps> = memo(
  ({ type, size = "medium", className = "" }) => {
    const numericSize =
      typeof size === "number" ? size : (SIZE_MAP[size] ?? 20);
    const Icon = ICON_MAP[type];

    if (!Icon) return null;

    return (
      <Icon
        width={numericSize}
        height={numericSize}
        className={`shrink-0 object-contain ${className}`.trim()}
      />
    );
  }
);

DatabaseIcon.displayName = "DatabaseIcon";

/** Icon for DB CLI tools (sqlite3, mysql, psql, redis-cli, mongosh). Size 16 matches CLI clients. */
export const DbClientIcon: React.FC<{
  binary: string;
  size?: number;
  className?: string;
}> = memo(({ binary, size = 16, className = "" }) => {
  const Icon = DB_CLIENT_BINARY_TO_ICON[binary];
  if (!Icon) {
    return (
      <HugeiconsIcon
        icon={Database}
        data-icon="database"
        size={size}
        className={`shrink-0 text-text-2 ${className}`.trim()}
      />
    );
  }
  return (
    <Icon
      width={size}
      height={size}
      className={`shrink-0 object-contain ${className}`.trim()}
    />
  );
});
DbClientIcon.displayName = "DbClientIcon";
