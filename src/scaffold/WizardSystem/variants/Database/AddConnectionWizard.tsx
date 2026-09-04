/**
 * AddConnectionWizard — single-step wizard for adding a database connection.
 *
 * Uses WizardShell + WizardStepLayout (same pattern as ChannelWizard).
 * Supports SQLite, Supabase, and Turso providers.
 *
 * Used by:
 * - Integrations > Databases (full-page wizard)
 * - WorkStation > Database Manager (rendered inside a tab)
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { DatabaseIcon } from "@src/assets/databaseIcons";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import type {
  DatabaseConnectionConfig,
  DatabaseType,
} from "@src/engines/DatabaseCore";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";

import { useConnectionFormState } from "./useConnectionFormState";

interface AddConnectionWizardProps {
  onSave: (config: DatabaseConnectionConfig) => void;
  onCancel: () => void;
  existingConnectionNames?: string[];
}

const DB_TYPE_OPTIONS: SelectionGridOption<DatabaseType>[] = [
  {
    key: "mysql",
    label: "MySQL",
    tooltip: "MySQL / MariaDB",
    iconElement: <DatabaseIcon type="mysql" size={18} />,
    iconPreserveColor: true,
  },
  {
    key: "neon",
    label: "Neon",
    tooltip: "Serverless PostgreSQL",
    iconElement: <DatabaseIcon type="neon" size={18} />,
    iconPreserveColor: true,
  },
  {
    key: "postgres",
    label: "PostgreSQL",
    tooltip: "Direct PostgreSQL connection",
    iconElement: <DatabaseIcon type="postgres" size={18} />,
    iconPreserveColor: true,
  },
  {
    key: "sqlite",
    label: "SQLite",
    tooltip: "Local database file",
    iconElement: <DatabaseIcon type="sqlite" size={18} />,
    iconPreserveColor: true,
  },
  {
    key: "supabase",
    label: "Supabase",
    tooltip: "PostgreSQL cloud",
    iconElement: <DatabaseIcon type="supabase" size={18} />,
    iconPreserveColor: true,
  },
  {
    key: "turso",
    label: "Turso",
    tooltip: "Distributed SQLite",
    iconElement: <DatabaseIcon type="turso" size={18} />,
    iconPreserveColor: true,
  },
];

const AddConnectionWizard: React.FC<AddConnectionWizardProps> = ({
  onSave,
  onCancel,
  existingConnectionNames = [],
}) => {
  const { t } = useTranslation("integrations");
  const {
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
  } = useConnectionFormState({ existingConnectionNames });

  const footerLeft =
    testStatus === "success" ? (
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-success-6">
          {t("databases.detail.probeSuccess")}
        </span>
      </div>
    ) : undefined;

  const stepActions = saved ? (
    <Button variant="primary" size="small" onClick={onCancel}>
      {t("common:actions.done", "Done")}
    </Button>
  ) : (
    <Button
      variant="primary"
      size="small"
      onClick={() => handleSave(onSave)}
      disabled={!isFormValid}
    >
      {t("databases.wizard.addConnection")}
    </Button>
  );

  return (
    <WizardShell title={t("databases.wizard.title")} onCancel={onCancel}>
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        onCancel={onCancel}
        actions={stepActions}
        footerLeft={footerLeft}
      >
        <div className={SECTION_GAP_CLASSES}>
          <SectionContainer>
            <SectionRow
              label={t("databases.wizard.providerType")}
              description={t("databases.wizard.providerTypeDesc")}
              layout="vertical"
              required
            >
              <SelectionGrid
                options={DB_TYPE_OPTIONS}
                selected={dbType}
                cardVariant="subtle"
                onSelect={handleTypeChange}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("databases.wizard.connectionNameOptional")}
              description={t("databases.wizard.connectionNameOptionalDesc", {
                provider: connectionNameBase,
              })}
            >
              <Input
                value={connectionName}
                onChange={setConnectionName}
                placeholder={t("databases.wizard.connectionNamePlaceholder", {
                  provider: connectionNameBase,
                })}
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>

            {dbType === "sqlite" && (
              <SectionRow
                label={t("common:database.databaseFile")}
                description={t("databases.wizard.databaseFileDesc")}
                required
              >
                <div className="flex gap-2" style={SECTION_CONTROL_STYLE}>
                  <Input
                    className="flex-1"
                    value={filePath}
                    onChange={setFilePath}
                    placeholder="/path/to/database.sqlite"
                  />
                  <Button variant="secondary" onClick={handleBrowseFile}>
                    {t("common:actions.browse")}
                  </Button>
                </div>
              </SectionRow>
            )}

            {dbType === "supabase" && (
              <>
                <SectionRow
                  label={t("common:database.projectUrl")}
                  description={t("databases.wizard.projectUrlDesc")}
                  required
                >
                  <Input
                    value={supabaseUrl}
                    onChange={setSupabaseUrl}
                    placeholder="https://xxxxx.supabase.co"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow
                  label={t("common:database.accessToken")}
                  description={t("databases.wizard.accessTokenDesc")}
                  required
                >
                  <Input
                    type="password"
                    value={supabaseToken}
                    onChange={setSupabaseToken}
                    placeholder="sbp_xxx..."
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
              </>
            )}

            {dbType === "turso" && (
              <>
                <SectionRow
                  label={t("common:database.databaseUrl")}
                  description={t("databases.wizard.databaseUrlDesc")}
                  required
                >
                  <Input
                    value={tursoUrl}
                    onChange={setTursoUrl}
                    placeholder="libsql://my-db-username.turso.io"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow
                  label={t("common:database.authToken")}
                  description={t("databases.wizard.authTokenDesc")}
                >
                  <Input
                    type="password"
                    value={tursoToken}
                    onChange={setTursoToken}
                    placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
              </>
            )}

            {dbType === "neon" && (
              <SectionRow
                label={t("common:database.connectionString")}
                description={t("databases.wizard.neonConnStringDesc")}
                required
              >
                <Input
                  value={neonConnString}
                  onChange={setNeonConnString}
                  placeholder="postgres://user:pass@ep-xxx.neon.tech/dbname"
                  style={SECTION_CONTROL_STYLE}
                />
              </SectionRow>
            )}

            {dbType === "postgres" && (
              <>
                <SectionRow
                  label={t("common:database.host")}
                  description={t("databases.wizard.pgHostDesc")}
                  required
                >
                  <Input
                    value={pgHost}
                    onChange={setPgHost}
                    placeholder="localhost"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.port")}>
                  <Input
                    value={pgPort}
                    onChange={setPgPort}
                    placeholder="5432"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.database")} required>
                  <Input
                    value={pgDatabase}
                    onChange={setPgDatabase}
                    placeholder="mydb"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.user")} required>
                  <Input
                    value={pgUser}
                    onChange={setPgUser}
                    placeholder="postgres"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.password")}>
                  <Input
                    type="password"
                    value={pgPassword}
                    onChange={setPgPassword}
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow
                  label={t("common:database.ssl")}
                  description={t("databases.wizard.pgSslDesc")}
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={pgSsl}
                      onChange={(event) => setPgSsl(event.target.checked)}
                      className="h-4 w-4 rounded border-border-2"
                    />
                    <span className="text-[13px] text-text-2">SSL</span>
                  </label>
                </SectionRow>
              </>
            )}

            {dbType === "mysql" && (
              <>
                <SectionRow
                  label={t("common:database.host")}
                  description={t("databases.wizard.mysqlHostDesc")}
                  required
                >
                  <Input
                    value={mysqlHost}
                    onChange={setMysqlHost}
                    placeholder="localhost"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.port")}>
                  <Input
                    value={mysqlPort}
                    onChange={setMysqlPort}
                    placeholder="3306"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.database")} required>
                  <Input
                    value={mysqlDatabase}
                    onChange={setMysqlDatabase}
                    placeholder="mydb"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.user")} required>
                  <Input
                    value={mysqlUser}
                    onChange={setMysqlUser}
                    placeholder="root"
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
                <SectionRow label={t("common:database.password")}>
                  <Input
                    type="password"
                    value={mysqlPassword}
                    onChange={setMysqlPassword}
                    style={SECTION_CONTROL_STYLE}
                  />
                </SectionRow>
              </>
            )}
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("databases.detail.testConnection")}
              description={t("databases.wizard.testConnectionDesc")}
              required
            >
              <Button
                variant={testStatus === "success" ? "success" : "primary"}
                appearance={testStatus === "success" ? "outline" : undefined}
                size="default"
                loading={testStatus === "testing"}
                disabled={!isFormValid || testStatus === "testing"}
                onClick={handleTest}
                className="h-8 min-h-8"
              >
                {testStatus === "success"
                  ? `✓ ${t("databases.detail.probeSuccess")}`
                  : testStatus === "testing"
                    ? t("common:status.testing")
                    : t("databases.detail.testConnection")}
              </Button>
            </SectionRow>
            {testStatus === "error" && !testErrorDismissed && (
              <div className="px-4 pb-3">
                <InlineAlert
                  type="danger"
                  onClose={() => setTestErrorDismissed(true)}
                >
                  {testError || t("databases.detail.probeFailed")}
                </InlineAlert>
              </div>
            )}
          </SectionContainer>

          {saved && (
            <InlineAlert type="success" title={t("databases.wizard.saved")}>
              <span className="text-[12px]">
                {t("databases.wizard.savedDesc")}
              </span>
            </InlineAlert>
          )}
        </div>
      </WizardStepLayout>
    </WizardShell>
  );
};

export default AddConnectionWizard;
