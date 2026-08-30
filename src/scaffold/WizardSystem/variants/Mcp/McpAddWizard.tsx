/**
 * McpAddWizard Component
 *
 * Single-step wizard for adding/editing an MCP server.
 * Config form + inline test/save results in one step.
 *
 * Uses WizardShell, WizardStepLayout, SectionContainer, SectionRow, SelectionGrid.
 * State and handlers live in useMcpAddWizard.ts.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Switch from "@src/components/Switch";
import Textarea from "@src/components/Textarea";
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  ComputerTerminal01Icon,
  HugeiconsIcon,
  InternetIcon,
} from "@src/icons";
import type {
  McpServerConfig,
  McpTestResult,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";

import { KvTableEditor } from "./KvTableEditor";
import {
  type McpTransportType,
  formatArgs,
  parseArgs,
  useMcpAddWizard,
} from "./useMcpAddWizard";

export interface McpAddWizardProps {
  onSave: (
    name: string,
    config: McpServerConfig,
    scope: McpConfigScope
  ) => Promise<void>;
  onTest: (name: string, config: McpServerConfig) => Promise<McpTestResult>;
  onCancel: () => void;
  editName?: string;
  editConfig?: McpServerConfig;
  /** Initial scope when editing; defaults to "global" for new servers. */
  initialScope?: McpConfigScope;
}

const McpAddWizard: React.FC<McpAddWizardProps> = ({
  onSave,
  onTest,
  onCancel,
  editName,
  editConfig,
  initialScope,
}) => {
  const { t } = useTranslation("integrations");
  const w = useMcpAddWizard({
    onSave,
    onTest,
    onCancel,
    editName,
    editConfig,
    initialScope,
  });

  return (
    <WizardShell title={w.wizardTitle} onCancel={onCancel}>
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        onCancel={onCancel}
        actions={
          <>
            <Button
              variant="secondary"
              size="small"
              onClick={w.handleTest}
              disabled={!w.canSave || w.testing}
              loading={w.testing}
            >
              {t("mcp.testConnection")}
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={w.handleSave}
              disabled={!w.canSave || w.saving}
              loading={w.saving}
            >
              {t("common:actions.save")}
            </Button>
          </>
        }
      >
        <>
          <SectionContainer>
            <SectionRow
              label={t("mcp.serverName")}
              description={t("mcp.serverNameDesc")}
            >
              <Input
                placeholder="my-mcp-server"
                value={w.serverName}
                onChange={w.setServerName}
                size="default"
                style={SECTION_CONTROL_STYLE}
                allowClear
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                error={!!w.nameError}
              />
            </SectionRow>

            <SectionRow
              label={t("mcp.transport")}
              description={t("mcp.transportDesc")}
              layout="vertical"
            >
              <SelectionGrid
                options={w.transportOptions}
                selected={w.transportType}
                cardVariant="subtle"
                onSelect={(key) => {
                  const typed = key as McpTransportType;
                  w.setTransportType(typed);
                  w.setConfig((prev) => ({ ...prev, type: typed }));
                }}
              />
            </SectionRow>

            <SectionRow
              label={t("mcp.scope")}
              description={t("mcp.scopeDesc")}
              layout="vertical"
            >
              <SelectionGrid
                options={[
                  {
                    key: "global" as const,
                    label: t("mcp.scopeGlobal"),
                    icon: InternetIcon,
                  },
                  {
                    key: "workspace" as const,
                    label: t("mcp.scopeWorkspace"),
                    icon: ComputerTerminal01Icon,
                  },
                ]}
                selected={w.scope}
                cardVariant="subtle"
                onSelect={(key) => w.setScope(key as McpConfigScope)}
              />
            </SectionRow>
          </SectionContainer>

          {w.transportType === "stdio" ? (
            <>
              <SectionContainer>
                <SectionRow
                  label={t("mcp.command")}
                  description={t("mcp.commandDesc")}
                >
                  <Input
                    placeholder="npx"
                    value={w.config.command ?? ""}
                    onChange={(value) =>
                      w.setConfig((prev) => ({
                        ...prev,
                        command: typeof value === "string" ? value : value,
                      }))
                    }
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </SectionRow>
                <SectionRow
                  label={t("mcp.args")}
                  description={t("mcp.argsDesc")}
                >
                  <Textarea
                    placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                    value={formatArgs(w.config.args ?? [])}
                    onChange={(value) => {
                      const str =
                        typeof value === "string" ? value : String(value);
                      w.setConfig((prev) => ({
                        ...prev,
                        args: parseArgs(str),
                      }));
                    }}
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    resize="vertical"
                  />
                </SectionRow>
                <SectionRow label={t("mcp.cwd")} description={t("mcp.cwdDesc")}>
                  <Input
                    placeholder="/Users/me/projects/foo"
                    value={w.config.cwd ?? ""}
                    onChange={(value) => {
                      const str =
                        typeof value === "string" ? value : String(value);
                      w.setConfig((prev) => ({
                        ...prev,
                        cwd: str.trim().length > 0 ? str : undefined,
                      }));
                    }}
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </SectionRow>
              </SectionContainer>

              <SectionContainer>
                <SectionRow
                  label={t("mcp.envVars")}
                  description={t("mcp.envVarsHint")}
                />
                <SectionRow label="" showHeader={false}>
                  <KvTableEditor
                    rows={w.envRows}
                    onUpdate={w.updateEnvRow}
                    onRemove={w.removeEnvRow}
                    onAdd={w.addEnvRow}
                    keyLabel={t("mcp.envKey")}
                    valueLabel={t("mcp.envValue")}
                    addLabel={t("mcp.addEnvVar")}
                  />
                </SectionRow>
              </SectionContainer>
            </>
          ) : (
            <>
              <SectionContainer>
                <SectionRow label={t("mcp.url")} description={t("mcp.urlDesc")}>
                  <Input
                    placeholder="http://localhost:3000/mcp"
                    value={w.config.url ?? ""}
                    onChange={(value) =>
                      w.setConfig((prev) => ({
                        ...prev,
                        url: typeof value === "string" ? value : value,
                      }))
                    }
                    size="default"
                    style={SECTION_CONTROL_STYLE}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </SectionRow>
              </SectionContainer>

              <SectionContainer>
                <SectionRow
                  label={t("mcp.headers")}
                  description={t("mcp.headersHint")}
                />
                <SectionRow label="" showHeader={false}>
                  <KvTableEditor
                    rows={w.headerRows}
                    onUpdate={w.updateHeaderRow}
                    onRemove={w.removeHeaderRow}
                    onAdd={w.addHeaderRow}
                    keyLabel={t("mcp.headerKey")}
                    valueLabel={t("mcp.headerValue")}
                    addLabel={t("mcp.addHeader")}
                  />
                </SectionRow>
              </SectionContainer>
            </>
          )}

          <SectionContainer>
            <SectionRow
              label={t("mcp.autoApprove")}
              description={t("mcp.autoApproveHint")}
            >
              <Input
                placeholder={t("mcp.autoApprovePlaceholder")}
                value={(w.config.autoApprove ?? []).join(" ")}
                onChange={(value) => {
                  const str = typeof value === "string" ? value : String(value);
                  const tools = str.split(" ").filter(Boolean);
                  w.setConfig((prev) => ({
                    ...prev,
                    autoApprove: tools.length > 0 ? tools : undefined,
                  }));
                }}
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("mcp.timeout")}
              description={t("mcp.timeoutDesc")}
            >
              <Input
                type="number"
                placeholder="30"
                value={String(w.config.timeout ?? 30)}
                onChange={(value) => {
                  const str = typeof value === "string" ? value : String(value);
                  const parsed = Number.parseInt(str, 10);
                  w.setConfig((prev) => ({
                    ...prev,
                    timeout:
                      Number.isFinite(parsed) && parsed > 0 ? parsed : 30,
                  }));
                }}
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>
            <SectionRow
              label={t("mcp.enabled")}
              description={t("mcp.enabledDesc")}
            >
              <Switch
                checked={!w.config.disabled}
                onCheckedChange={(checked) =>
                  w.setConfig((prev) => ({ ...prev, disabled: !checked }))
                }
              />
            </SectionRow>
          </SectionContainer>

          {w.testResult && !w.testing && (
            <InlineAlert
              type={w.testResult.success ? "success" : "danger"}
              title={
                w.testResult.success
                  ? t("mcp.testSuccess")
                  : t("mcp.testFailed")
              }
            >
              {w.testResult.success ? (
                <span className="flex items-center gap-1.5">
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    data-icon="check-circle-2"
                    size={14}
                  />
                  {w.testResult.toolCount} {t("mcp.toolsDiscovered")}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <HugeiconsIcon
                    icon={CancelCircleIcon}
                    data-icon="xcircle"
                    size={14}
                  />
                  {w.testResult.error ?? t("mcp.connectionFailed")}
                </span>
              )}
            </InlineAlert>
          )}

          {w.error && !w.testing && (
            <InlineAlert type="danger" title={t("common:status.error")}>
              {w.error}
            </InlineAlert>
          )}
        </>
      </WizardStepLayout>
    </WizardShell>
  );
};

export default McpAddWizard;
