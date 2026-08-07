import { memo } from "react";
import { useTranslation } from "react-i18next";

import { AddConnectionFormField } from "./AddConnectionFormField";

export interface MysqlConnectionFieldsProps {
  mysqlHost: string;
  mysqlPort: string;
  mysqlDatabase: string;
  mysqlUser: string;
  mysqlPassword: string;
  onMysqlHostChange: (value: string) => void;
  onMysqlPortChange: (value: string) => void;
  onMysqlDatabaseChange: (value: string) => void;
  onMysqlUserChange: (value: string) => void;
  onMysqlPasswordChange: (value: string) => void;
}

export const MysqlConnectionFields = memo(function MysqlConnectionFields({
  mysqlHost,
  mysqlPort,
  mysqlDatabase,
  mysqlUser,
  mysqlPassword,
  onMysqlHostChange,
  onMysqlPortChange,
  onMysqlDatabaseChange,
  onMysqlUserChange,
  onMysqlPasswordChange,
}: MysqlConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-2">
        <AddConnectionFormField
          className="col-span-2"
          label={t("database.host")}
          value={mysqlHost}
          onChange={onMysqlHostChange}
          placeholder="localhost"
        />
        <AddConnectionFormField
          label={t("database.port")}
          value={mysqlPort}
          onChange={onMysqlPortChange}
          placeholder="3306"
        />
      </div>
      <AddConnectionFormField
        className="mb-4"
        label={t("database.database")}
        value={mysqlDatabase}
        onChange={onMysqlDatabaseChange}
        placeholder="mydb"
      />
      <div className="mb-4 grid grid-cols-2 gap-2">
        <AddConnectionFormField
          label={t("database.user")}
          value={mysqlUser}
          onChange={onMysqlUserChange}
          placeholder="root"
        />
        <AddConnectionFormField
          label={
            <>
              {t("database.password")}{" "}
              <span className="font-normal text-text-4">({t("optional")})</span>
            </>
          }
          type="password"
          value={mysqlPassword}
          onChange={onMysqlPasswordChange}
        />
      </div>
    </>
  );
});
