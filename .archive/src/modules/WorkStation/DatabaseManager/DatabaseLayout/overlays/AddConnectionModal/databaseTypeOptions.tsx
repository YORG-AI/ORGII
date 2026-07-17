import React from "react";

import { DatabaseIcon } from "@src/assets/databaseIcons";
import type { DatabaseType } from "@src/engines/DatabaseCore";

export interface DatabaseTypeOption {
  type: DatabaseType;
  name: string;
  descriptionKey: string;
  icon: React.ReactNode;
}

export const DATABASE_TYPE_OPTIONS: DatabaseTypeOption[] = [
  {
    type: "sqlite",
    name: "SQLite",
    descriptionKey: "database.sqliteDescription",
    icon: <DatabaseIcon type="sqlite" size={18} />,
  },
  {
    type: "postgres",
    name: "PostgreSQL",
    descriptionKey: "database.postgresDescription",
    icon: <DatabaseIcon type="postgres" size={18} />,
  },
  {
    type: "mysql",
    name: "MySQL",
    descriptionKey: "database.mysqlDescription",
    icon: <DatabaseIcon type="mysql" size={18} />,
  },
  {
    type: "supabase",
    name: "Supabase",
    descriptionKey: "database.supabaseDescription",
    icon: <DatabaseIcon type="supabase" size={18} />,
  },
  {
    type: "neon",
    name: "Neon",
    descriptionKey: "database.neonDescription",
    icon: <DatabaseIcon type="neon" size={18} />,
  },
  {
    type: "turso",
    name: "Turso",
    descriptionKey: "database.tursoDescription",
    icon: <DatabaseIcon type="turso" size={18} />,
  },
];
