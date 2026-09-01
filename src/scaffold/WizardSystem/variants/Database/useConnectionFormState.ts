import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type DatabaseConnectionConfig,
  DatabaseServiceFactory,
  type DatabaseType,
  type MySQLConnectionConfig,
  type NeonConnectionConfig,
  type PostgresConnectionConfig,
  type SqliteConnectionConfig,
  type SupabaseConnectionConfig,
  type TursoConnectionConfig,
  isValidSqliteFile,
} from "@src/engines/DatabaseCore";

type TestStatus = "idle" | "testing" | "success" | "error";

interface UseConnectionFormStateOptions {
  existingConnectionNames?: string[];
}

function nextDefaultName(baseName: string, existingNames: string[]): string {
  const normalizedExistingNames = new Set(
    existingNames.map((name) => name.trim().toLowerCase())
  );
  if (!normalizedExistingNames.has(baseName.toLowerCase())) return baseName;

  let suffix = 1;
  while (normalizedExistingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

interface ConnectionFormState {
  dbType: DatabaseType;
  connectionName: string;
  connectionNameBase: string;
  filePath: string;
  supabaseUrl: string;
  supabaseToken: string;
  tursoUrl: string;
  tursoToken: string;
  neonConnString: string;
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgSsl: boolean;
  mysqlHost: string;
  mysqlPort: string;
  mysqlDatabase: string;
  mysqlUser: string;
  mysqlPassword: string;
  testStatus: TestStatus;
  testError: string | null;
  testErrorDismissed: boolean;
  saved: boolean;
}

interface ConnectionFormActions {
  setDbType: (dbType: DatabaseType) => void;
  setConnectionName: (name: string) => void;
  setFilePath: (path: string) => void;
  setSupabaseUrl: (url: string) => void;
  setSupabaseToken: (token: string) => void;
  setTursoUrl: (url: string) => void;
  setTursoToken: (token: string) => void;
  setNeonConnString: (connString: string) => void;
  setPgHost: (host: string) => void;
  setPgPort: (port: string) => void;
  setPgDatabase: (db: string) => void;
  setPgUser: (user: string) => void;
  setPgPassword: (password: string) => void;
  setPgSsl: (ssl: boolean) => void;
  setMysqlHost: (host: string) => void;
  setMysqlPort: (port: string) => void;
  setMysqlDatabase: (db: string) => void;
  setMysqlUser: (user: string) => void;
  setMysqlPassword: (password: string) => void;
  setTestErrorDismissed: (dismissed: boolean) => void;
  isFormValid: boolean;
  handleBrowseFile: () => Promise<void>;
  handleTest: () => Promise<void>;
  handleSave: (onSave: (config: DatabaseConnectionConfig) => void) => void;
  handleTypeChange: (key: string) => void;
}

export function useConnectionFormState(
  options: UseConnectionFormStateOptions = {}
): ConnectionFormState & ConnectionFormActions {
  const { existingConnectionNames = [] } = options;

  const [dbType, setDbType] = useState<DatabaseType>("sqlite");
  const [connectionName, setConnectionName] = useState("");

  const [filePath, setFilePath] = useState("");
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseToken, setSupabaseToken] = useState("");
  const [tursoUrl, setTursoUrl] = useState("");
  const [tursoToken, setTursoToken] = useState("");
  const [neonConnString, setNeonConnString] = useState("");

  const [pgHost, setPgHost] = useState("");
  const [pgPort, setPgPort] = useState("5432");
  const [pgDatabase, setPgDatabase] = useState("");
  const [pgUser, setPgUser] = useState("");
  const [pgPassword, setPgPassword] = useState("");
  const [pgSsl, setPgSsl] = useState(false);

  const [mysqlHost, setMysqlHost] = useState("");
  const [mysqlPort, setMysqlPort] = useState("3306");
  const [mysqlDatabase, setMysqlDatabase] = useState("");
  const [mysqlUser, setMysqlUser] = useState("");
  const [mysqlPassword, setMysqlPassword] = useState("");

  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [testErrorDismissed, setTestErrorDismissed] = useState(false);
  const [saved, setSaved] = useState(false);

  const connectionNameBase = useMemo(() => {
    switch (dbType) {
      case "mysql":
        return "MySQL";
      case "neon":
        return "Neon";
      case "postgres":
        return "PostgreSQL";
      case "sqlite":
        return "SQLite";
      case "supabase":
        return "Supabase";
      case "turso":
        return "Turso";
      default:
        return dbType;
    }
  }, [dbType]);

  useEffect(() => {
    if (testError) setTestErrorDismissed(false);
  }, [testError]);

  const handleBrowseFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "SQLite Database", extensions: ["sqlite", "sqlite3", "db"] },
        ],
      });
      if (selected && typeof selected === "string") {
        setFilePath(selected);
        if (!connectionName) {
          const name =
            selected
              .split("/")
              .pop()
              ?.replace(/\.[^.]+$/, "") || "";
          setConnectionName(name);
        }
      }
    } catch (_err) {
      // File dialog cancelled
    }
  }, [connectionName]);

  const isFormValid = useMemo(() => {
    switch (dbType) {
      case "sqlite":
        return !!filePath;
      case "supabase":
        return !!supabaseUrl && !!supabaseToken;
      case "turso":
        return !!tursoUrl;
      case "neon":
        return !!neonConnString;
      case "postgres":
        return !!pgHost && !!pgDatabase && !!pgUser;
      case "mysql":
        return !!mysqlHost && !!mysqlDatabase && !!mysqlUser;
      default:
        return false;
    }
  }, [
    dbType,
    filePath,
    supabaseUrl,
    supabaseToken,
    tursoUrl,
    neonConnString,
    pgHost,
    pgDatabase,
    pgUser,
    mysqlHost,
    mysqlDatabase,
    mysqlUser,
  ]);

  const buildConfig = useCallback((): DatabaseConnectionConfig | null => {
    const base = {
      id: `${dbType}:${crypto.randomUUID()}`,
      name:
        connectionName.trim() ||
        nextDefaultName(connectionNameBase, existingConnectionNames),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    switch (dbType) {
      case "sqlite":
        if (!filePath) return null;
        return {
          ...base,
          type: "sqlite",
          filePath,
        } as SqliteConnectionConfig;
      case "supabase":
        if (!supabaseUrl || !supabaseToken) return null;
        return {
          ...base,
          type: "supabase",
          url: supabaseUrl.trim(),
          accessToken: supabaseToken.trim(),
        } as SupabaseConnectionConfig;
      case "turso":
        if (!tursoUrl) return null;
        return {
          ...base,
          type: "turso",
          url: tursoUrl.trim(),
          authToken: tursoToken.trim() || undefined,
        } as TursoConnectionConfig;
      case "neon":
        if (!neonConnString) return null;
        return {
          ...base,
          type: "neon",
          connectionString: neonConnString.trim(),
        } as NeonConnectionConfig;
      case "postgres":
        if (!pgHost || !pgDatabase || !pgUser) return null;
        return {
          ...base,
          type: "postgres",
          host: pgHost.trim(),
          port: parseInt(pgPort, 10) || 5432,
          database: pgDatabase.trim(),
          user: pgUser.trim(),
          password: pgPassword || undefined,
          ssl: pgSsl,
        } as PostgresConnectionConfig;
      case "mysql":
        if (!mysqlHost || !mysqlDatabase || !mysqlUser) return null;
        return {
          ...base,
          type: "mysql",
          host: mysqlHost.trim(),
          port: parseInt(mysqlPort, 10) || 3306,
          database: mysqlDatabase.trim(),
          user: mysqlUser.trim(),
          password: mysqlPassword || undefined,
        } as MySQLConnectionConfig;
      default:
        return null;
    }
  }, [
    dbType,
    connectionName,
    connectionNameBase,
    existingConnectionNames,
    filePath,
    supabaseUrl,
    supabaseToken,
    tursoUrl,
    tursoToken,
    neonConnString,
    pgHost,
    pgPort,
    pgDatabase,
    pgUser,
    pgPassword,
    pgSsl,
    mysqlHost,
    mysqlPort,
    mysqlDatabase,
    mysqlUser,
    mysqlPassword,
  ]);

  const handleTest = useCallback(async () => {
    const config = buildConfig();
    if (!config) return;

    setTestStatus("testing");
    setTestError(null);

    try {
      if (config.type === "sqlite") {
        const isValid = await isValidSqliteFile(config.filePath);
        if (!isValid) throw new Error("Not a valid SQLite file");
      }

      const service = await DatabaseServiceFactory.create(config, true);
      await service.connect();
      await service.getTables();
      await service.disconnect();
      DatabaseServiceFactory.remove(config.id);

      setTestStatus("success");
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
      setTestStatus("error");
    }
  }, [buildConfig]);

  const handleSave = useCallback(
    (onSave: (config: DatabaseConnectionConfig) => void) => {
      const config = buildConfig();
      if (!config) return;
      onSave(config);
      setSaved(true);
    },
    [buildConfig]
  );

  const handleTypeChange = useCallback((key: string) => {
    setDbType(key as DatabaseType);
    setTestStatus("idle");
    setTestError(null);
  }, []);

  return {
    dbType,
    connectionName,
    connectionNameBase,
    filePath,
    supabaseUrl,
    supabaseToken,
    tursoUrl,
    tursoToken,
    neonConnString,
    pgHost,
    pgPort,
    pgDatabase,
    pgUser,
    pgPassword,
    pgSsl,
    mysqlHost,
    mysqlPort,
    mysqlDatabase,
    mysqlUser,
    mysqlPassword,
    testStatus,
    testError,
    testErrorDismissed,
    saved,
    setDbType,
    setConnectionName,
    setFilePath,
    setSupabaseUrl,
    setSupabaseToken,
    setTursoUrl,
    setTursoToken,
    setNeonConnString,
    setPgHost,
    setPgPort,
    setPgDatabase,
    setPgUser,
    setPgPassword,
    setPgSsl,
    setMysqlHost,
    setMysqlPort,
    setMysqlDatabase,
    setMysqlUser,
    setMysqlPassword,
    setTestErrorDismissed,
    isFormValid,
    handleBrowseFile,
    handleTest,
    handleSave,
    handleTypeChange,
  };
}
