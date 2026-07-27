/**
 * Flat grid of all "Add" actions for the Integrations page.
 * Each card opens the corresponding wizard / browse panel in the right panel.
 */
import { Database, Download, Key, Plus, Unplug } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { McpLogoIcon } from "@src/assets/channelIcons/McpLogoIcon";

import type { AddAction } from "./types";

interface AddOptionItem {
  action: AddAction;
  labelKey: string;
  icon: React.ReactNode;
}

const ADD_OPTIONS: AddOptionItem[] = [
  {
    action: "add-model",
    labelKey: "addOptions.addModel",
    icon: <Key size={18} strokeWidth={1.5} />,
  },
  {
    action: "add-connection",
    labelKey: "addOptions.addConnection",
    icon: <Unplug size={18} strokeWidth={1.5} />,
  },
  {
    action: "add-database",
    labelKey: "addOptions.addDatabase",
    icon: <Database size={18} strokeWidth={1.5} />,
  },
  {
    action: "add-mcp",
    labelKey: "addOptions.addMcp",
    icon: <McpLogoIcon size={18} />,
  },
  {
    action: "create-skill",
    labelKey: "addOptions.createSkill",
    icon: <Plus size={18} strokeWidth={1.5} />,
  },
  {
    action: "import-skill",
    labelKey: "addOptions.importSkill",
    icon: <Download size={18} strokeWidth={1.5} />,
  },
];

interface AddOptionsGridProps {
  onAction: (action: AddAction) => void;
}

const AddOptionsGrid: React.FC<AddOptionsGridProps> = ({ onAction }) => {
  const { t } = useTranslation("integrations");

  return (
    <div className="flex flex-col gap-1">
      {ADD_OPTIONS.map((option) => (
        <button
          key={option.action}
          className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] text-text-1 transition-colors hover:bg-fill-2"
          onClick={() => onAction(option.action)}
        >
          <span className="flex-shrink-0 text-text-3">{option.icon}</span>
          <span>
            {t(option.labelKey, { defaultValue: formatDefault(option.action) })}
          </span>
        </button>
      ))}
    </div>
  );
};

function formatDefault(action: AddAction): string {
  const MAP: Record<AddAction, string> = {
    "add-model": "Add Account",
    "add-connection": "Add",
    "add-git-connection": "Add Git Connection",
    "add-database": "Add Database",
    "add-mcp": "Add MCP Server",
    "create-skill": "Create Skill",
    "import-skill": "Import Skill",
    "add-rule": "Add Policy",
    "add-routine": "Add Routine",
  };
  return MAP[action];
}

export default AddOptionsGrid;
