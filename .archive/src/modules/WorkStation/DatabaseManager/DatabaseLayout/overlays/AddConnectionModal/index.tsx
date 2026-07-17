import { open } from "@tauri-apps/plugin-dialog";
import React, { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
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
import { createLogger } from "@src/hooks/logger";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";

import { AddConnectionModalHeader } from "./AddConnectionModalHeader";
import { ConnectionNameField } from "./ConnectionNameField";
import { ConnectionTestStatusBanner } from "./ConnectionTestStatusBanner";
import { DatabaseTypeSelector } from "./DatabaseTypeSelector";
import { MysqlConnectionFields } from "./MysqlConnectionFields";
import { NeonConnectionFields } from "./NeonConnectionFields";
import { PostgresConnectionFields } from "./PostgresConnectionFields";
import { SqliteConnectionFields } from "./SqliteConnectionFields";
import { SupabaseConnectionFields } from "./SupabaseConnectionFields";
import { TursoConnectionFields } from "./TursoConnectionFields";
import { DATABASE_TYPE_OPTIONS } from "./databaseTypeOptions";
import "./index.scss";
import type { AddConnectionModalProps, ConnectionStatus } from "./types";

export type { AddConnectionModalProps } from "./types";

const log = createLogger("AddConnectionModal");

export const AddConnectionModal: React.FC<AddConnectionModalProps> = memo(
  ({ isOpen, onAdd, onClose }) => {
    const { t } = useTranslation();

    const [selectedType, setSelectedType] = useState<DatabaseType>("sqlite");
    const [connectionName, setConnectionName] = useState("");

    const [filePath, setFilePath] = useState("");

    const [supabaseUrl, setSupabaseUrl] = useState("");
    const [supabaseAccessToken, setSupabaseAccessToken] = useState("");

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

    const [testStatus, setTestStatus] = useState<ConnectionStatus>("idle");
    const [testError, setTestError] = useState<string | null>(null);

    useEffect(() => {
      if (isOpen) {
        setSelectedType("sqlite");
        setConnectionName("");
        setFilePath("");
        setSupabaseUrl("");
        setSupabaseAccessToken("");
        setTursoUrl("");
        setTursoToken("");
        setNeonConnString("");
        setPgHost("");
        setPgPort("5432");
        setPgDatabase("");
        setPgUser("");
        setPgPassword("");
        setPgSsl(false);
        setMysqlHost("");
        setMysqlPort("3306");
        setMysqlDatabase("");
        setMysqlUser("");
        setMysqlPassword("");
        setTestStatus("idle");
        setTestError(null);
      }
    }, [isOpen]);

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && isOpen) {
          onClose();
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose]);

    const handleBackdropClick = useCallback(
      (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      },
      [onClose]
    );

    const handleSelectType = useCallback((type: DatabaseType) => {
      setSelectedType(type);
      setTestStatus("idle");
      setTestError(null);
    }, []);

    const handleBrowseFile = useCallback(async () => {
      try {
        const selected = await open({
          multiple: false,
          filters: [
            {
              name: "SQLite Database",
              extensions: ["sqlite", "sqlite3", "db"],
            },
          ],
        });
        if (selected && typeof selected === "string") {
          setFilePath(selected);
          setConnectionName((previous) => {
            if (previous) return previous;
            return (
              selected
                .split("/")
                .pop()
                ?.replace(/\.[^.]+$/, "") || ""
            );
          });
        }
      } catch (err) {
        log.error("Failed to open file dialog:", err);
      }
    }, []);

    const buildConfig = useCallback((): DatabaseConnectionConfig | null => {
      const baseConfig = {
        id: `${selectedType}:${Date.now()}`,
        name:
          connectionName.trim() ||
          t("database.newConnection", { type: selectedType }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      switch (selectedType) {
        case "sqlite":
          if (!filePath) return null;
          return {
            ...baseConfig,
            id: `sqlite:${filePath}`,
            type: "sqlite",
            filePath,
          } as SqliteConnectionConfig;

        case "supabase":
          if (!supabaseUrl || !supabaseAccessToken) return null;
          return {
            ...baseConfig,
            type: "supabase",
            url: supabaseUrl.trim(),
            accessToken: supabaseAccessToken.trim(),
          } as SupabaseConnectionConfig;

        case "turso":
          if (!tursoUrl) return null;
          return {
            ...baseConfig,
            type: "turso",
            url: tursoUrl.trim(),
            authToken: tursoToken.trim() || undefined,
          } as TursoConnectionConfig;

        case "neon":
          if (!neonConnString) return null;
          return {
            ...baseConfig,
            type: "neon",
            connectionString: neonConnString.trim(),
          } as NeonConnectionConfig;

        case "postgres":
          if (!pgHost || !pgDatabase || !pgUser) return null;
          return {
            ...baseConfig,
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
            ...baseConfig,
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
      selectedType,
      connectionName,
      filePath,
      supabaseUrl,
      supabaseAccessToken,
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
      t,
    ]);

    const handleTestConnection = useCallback(async () => {
      const config = buildConfig();
      if (!config) return;

      setTestStatus("testing");
      setTestError(null);

      try {
        if (config.type === "sqlite") {
          const isValid = await isValidSqliteFile(config.filePath);
          if (!isValid) {
            throw new Error(t("database.notValidSqlite"));
          }
        }

        const service = await DatabaseServiceFactory.create(config, true);
        await service.connect();
        await service.getTables();
        await service.disconnect();

        DatabaseServiceFactory.remove(config.id);

        setTestStatus("success");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("database.connectionFailed");
        setTestError(message);
        setTestStatus("error");
      }
    }, [buildConfig, t]);

    const handleSubmit = useCallback(
      async (event: React.FormEvent) => {
        event.preventDefault();
        const config = buildConfig();
        if (!config) return;

        setTestStatus("adding");
        setTestError(null);

        try {
          await onAdd(config);
          onClose();
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : t("database.failedToAddConnection");
          setTestError(message);
          setTestStatus("error");
        }
      },
      [buildConfig, onAdd, onClose, t]
    );

    const isFormValid = useCallback(() => {
      switch (selectedType) {
        case "sqlite":
          return !!filePath;
        case "supabase":
          return !!supabaseUrl && !!supabaseAccessToken;
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
      selectedType,
      filePath,
      supabaseUrl,
      supabaseAccessToken,
      tursoUrl,
      neonConnString,
      pgHost,
      pgDatabase,
      pgUser,
      mysqlHost,
      mysqlDatabase,
      mysqlUser,
    ]);

    if (!isOpen) {
      return null;
    }

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={handleBackdropClick}
      >
        <div
          className="add-connection-modal w-full max-w-lg rounded-lg border border-border-2 bg-workstation-bg shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <AddConnectionModalHeader onClose={onClose} />

          <form onSubmit={handleSubmit} className="p-4">
            <DatabaseTypeSelector
              options={DATABASE_TYPE_OPTIONS}
              selectedType={selectedType}
              onSelectType={handleSelectType}
            />

            <ConnectionNameField
              value={connectionName}
              onChange={setConnectionName}
            />

            {selectedType === "sqlite" && (
              <SqliteConnectionFields
                filePath={filePath}
                onFilePathChange={setFilePath}
                onBrowseFile={handleBrowseFile}
              />
            )}

            {selectedType === "supabase" && (
              <SupabaseConnectionFields
                supabaseUrl={supabaseUrl}
                supabaseAccessToken={supabaseAccessToken}
                onSupabaseUrlChange={setSupabaseUrl}
                onSupabaseAccessTokenChange={setSupabaseAccessToken}
              />
            )}

            {selectedType === "turso" && (
              <TursoConnectionFields
                tursoUrl={tursoUrl}
                tursoToken={tursoToken}
                onTursoUrlChange={setTursoUrl}
                onTursoTokenChange={setTursoToken}
              />
            )}

            {selectedType === "neon" && (
              <NeonConnectionFields
                neonConnString={neonConnString}
                onNeonConnStringChange={setNeonConnString}
              />
            )}

            {selectedType === "postgres" && (
              <PostgresConnectionFields
                pgHost={pgHost}
                pgPort={pgPort}
                pgDatabase={pgDatabase}
                pgUser={pgUser}
                pgPassword={pgPassword}
                pgSsl={pgSsl}
                onPgHostChange={setPgHost}
                onPgPortChange={setPgPort}
                onPgDatabaseChange={setPgDatabase}
                onPgUserChange={setPgUser}
                onPgPasswordChange={setPgPassword}
                onPgSslChange={setPgSsl}
              />
            )}

            {selectedType === "mysql" && (
              <MysqlConnectionFields
                mysqlHost={mysqlHost}
                mysqlPort={mysqlPort}
                mysqlDatabase={mysqlDatabase}
                mysqlUser={mysqlUser}
                mysqlPassword={mysqlPassword}
                onMysqlHostChange={setMysqlHost}
                onMysqlPortChange={setMysqlPort}
                onMysqlDatabaseChange={setMysqlDatabase}
                onMysqlUserChange={setMysqlUser}
                onMysqlPasswordChange={setMysqlPassword}
              />
            )}

            <ConnectionTestStatusBanner
              testStatus={testStatus}
              testError={testError}
            />

            <PanelFooter
              left={
                <Button
                  onClick={handleTestConnection}
                  disabled={
                    !isFormValid() ||
                    testStatus === "testing" ||
                    testStatus === "adding"
                  }
                >
                  {testStatus === "testing"
                    ? t("database.testing")
                    : t("database.testConnection")}
                </Button>
              }
              secondaryActions={[
                {
                  label: t("actions.cancel"),
                  onClick: onClose,
                  disabled: testStatus === "adding",
                  variant: "secondary",
                },
              ]}
              primaryAction={{
                label:
                  testStatus === "adding"
                    ? t("database.adding")
                    : t("database.addConnectionAction"),
                onClick: () => {},
                htmlType: "submit",
                disabled: !isFormValid() || testStatus === "adding",
              }}
            />
          </form>
        </div>
      </div>
    );
  }
);

AddConnectionModal.displayName = "AddConnectionModal";

export default AddConnectionModal;
