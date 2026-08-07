import { memo } from "react";
import { useTranslation } from "react-i18next";

import { AddConnectionFormField } from "./AddConnectionFormField";

export interface PostgresConnectionFieldsProps {
  pgHost: string;
  pgPort: string;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgSsl: boolean;
  onPgHostChange: (value: string) => void;
  onPgPortChange: (value: string) => void;
  onPgDatabaseChange: (value: string) => void;
  onPgUserChange: (value: string) => void;
  onPgPasswordChange: (value: string) => void;
  onPgSslChange: (value: boolean) => void;
}

export const PostgresConnectionFields = memo(function PostgresConnectionFields({
  pgHost,
  pgPort,
  pgDatabase,
  pgUser,
  pgPassword,
  pgSsl,
  onPgHostChange,
  onPgPortChange,
  onPgDatabaseChange,
  onPgUserChange,
  onPgPasswordChange,
  onPgSslChange,
}: PostgresConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <AddConnectionFormField
          className="col-span-2"
          label={t("database.host")}
          value={pgHost}
          onChange={onPgHostChange}
          placeholder="localhost"
        />
        <AddConnectionFormField
          label={t("database.port")}
          value={pgPort}
          onChange={onPgPortChange}
          placeholder="5432"
        />
      </div>
      <AddConnectionFormField
        className="mb-4"
        label={t("database.database")}
        value={pgDatabase}
        onChange={onPgDatabaseChange}
        placeholder="mydb"
      />
      <div className="mb-4 grid grid-cols-2 gap-2">
        <AddConnectionFormField
          label={t("database.user")}
          value={pgUser}
          onChange={onPgUserChange}
          placeholder="postgres"
        />
        <AddConnectionFormField
          label={
            <>
              {t("database.password")}{" "}
              <span className="font-normal text-text-4">({t("optional")})</span>
            </>
          }
          type="password"
          value={pgPassword}
          onChange={onPgPasswordChange}
        />
      </div>
      <div className="mb-4 flex items-center gap-2">
        <input
          type="checkbox"
          id="pg-ssl"
          checked={pgSsl}
          onChange={(event) => onPgSslChange(event.target.checked)}
          className="h-4 w-4 rounded border-border-2"
        />
        <label htmlFor="pg-ssl" className="text-xs text-text-2">
          {t("database.requireSsl")}
        </label>
      </div>
    </>
  );
});
