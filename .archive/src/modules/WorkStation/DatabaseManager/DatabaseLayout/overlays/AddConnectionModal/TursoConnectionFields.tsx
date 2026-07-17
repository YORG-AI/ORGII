import { memo } from "react";
import { useTranslation } from "react-i18next";

import { AddConnectionFormField } from "./AddConnectionFormField";

export interface TursoConnectionFieldsProps {
  tursoUrl: string;
  tursoToken: string;
  onTursoUrlChange: (value: string) => void;
  onTursoTokenChange: (value: string) => void;
}

export const TursoConnectionFields = memo(function TursoConnectionFields({
  tursoUrl,
  tursoToken,
  onTursoUrlChange,
  onTursoTokenChange,
}: TursoConnectionFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      <AddConnectionFormField
        className="mb-4"
        label={t("database.databaseUrl")}
        value={tursoUrl}
        onChange={onTursoUrlChange}
        placeholder="libsql://my-db-username.turso.io"
      />
      <AddConnectionFormField
        className="mb-4"
        label={
          <>
            {t("database.authToken")}{" "}
            <span className="font-normal text-text-4">({t("optional")})</span>
          </>
        }
        type="password"
        value={tursoToken}
        onChange={onTursoTokenChange}
        placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."
        hint={t("database.tursoTokenHint")}
      />
    </>
  );
});
