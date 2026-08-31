/**
 * OrgNodeCard — individual node in the team chart.
 *
 * Shows member name, role, agent badge.
 * Hover reveals action buttons: add child, edit, delete. When `readOnly`
 * is set, the hover action bar is omitted entirely (used by the wizard /
 * detail-view preview tabs, where editing happens via the Edit tab's
 * table, not the chart).
 */
import React from "react";
import { useTranslation } from "react-i18next";

import {
  Add01Icon,
  Delete02Icon,
  HugeiconsIcon,
  Pen01Icon,
  UserMultipleIcon,
} from "@src/icons";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";

import { AGENT_COLORS, DEFAULT_AGENT_COLOR } from "./config";

interface OrgNodeCardProps {
  node: OrgMember;
  agents?: AgentDefinition[];
  isSelected: boolean;
  canAddChild: boolean;
  onSelect: (id: string) => void;
  onAddChild: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  isRoot: boolean;
  readOnly?: boolean;
}

const OrgNodeCard: React.FC<OrgNodeCardProps> = ({
  node,
  agents,
  isSelected,
  canAddChild,
  onSelect,
  onAddChild,
  onEdit,
  onDelete,
  isRoot,
  readOnly = false,
}) => {
  const { t } = useTranslation("settings");

  const agentDef = agents?.find((agent) => agent.id === node.agentId);
  const agentLabel = agentDef?.name ?? node.agentId;
  const agentColor = AGENT_COLORS[node.agentId] ?? DEFAULT_AGENT_COLOR;

  return (
    <div
      className={`org-node-card group relative flex min-w-[180px] max-w-[260px] cursor-pointer flex-col gap-1.5 rounded-lg border px-4 py-3 transition-colors ${
        isSelected
          ? "border-primary-6 bg-bg-2"
          : "border-border-2 bg-bg-2 hover:border-border-3"
      }`}
      onClick={() => onSelect(node.id)}
    >
      {/* Icon + Name */}
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={UserMultipleIcon}
          data-icon="users"
          size={16}
          className="shrink-0 text-primary-6"
        />
        <span className="truncate text-[14px] font-medium text-text-1">
          {node.name}
        </span>
      </div>

      {/* Role */}
      {node.role && node.role !== "org" && (
        <span className="truncate text-xs text-text-3">{node.role}</span>
      )}

      {/* Agent badge */}
      <span className={`text-[11px] font-medium ${agentColor}`}>
        {agentLabel}
      </span>

      {!readOnly && (
        <div className="absolute -right-1 -top-3 flex gap-0.5 rounded-md border border-border-2 bg-bg-2 px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
          {canAddChild && (
            <button
              className="rounded p-0.5 hover:bg-fill-2"
              onClick={(event) => {
                event.stopPropagation();
                onAddChild(node.id);
              }}
              title={t("org.addChild")}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                data-icon="plus"
                size={12}
                className="text-text-2"
              />
            </button>
          )}
          <button
            className="rounded p-0.5 hover:bg-fill-2"
            onClick={(event) => {
              event.stopPropagation();
              onEdit(node.id);
            }}
            title={t("common:actions.edit")}
          >
            <HugeiconsIcon
              icon={Pen01Icon}
              data-icon="pencil"
              size={12}
              className="text-text-2"
            />
          </button>
          {!isRoot && (
            <button
              className="rounded p-0.5 hover:bg-danger-1"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(node.id);
              }}
              title={t("common:actions.delete")}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                data-icon="trash-2"
                size={12}
                className="text-danger-6"
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default OrgNodeCard;
