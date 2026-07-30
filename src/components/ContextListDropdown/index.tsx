/**
 * ContextListDropdown Component
 *
 * Dropdown showing list of context items with type icons and tags.
 * Uses centralized dropdown tokens for consistent styling.
 */
import {
  AlertCircle,
  Book,
  Clock,
  File,
  GitBranch,
  Image as ImageIcon,
  Images,
  Key,
  ListTodo,
  Loader2,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";

// Context item details type
export interface ContextItemDetails {
  title?: string;
  when_to_use?: string;
  format?: string;
  payload?: {
    content?: string;
    url?: string;
    [key: string]: unknown;
  };
  edited_at?: number;
  description?: string;
  fileId?: string;
  [key: string]: unknown;
}

// Context item type interface
export interface ContextItem {
  id: string;
  type:
    | "task_info"
    | "repo_info"
    | "general_reference"
    | "key"
    | "image"
    | "image_group";
  title: string;
  when_to_use?: string;
  format?: string;
  payload?: unknown;
  edited_at?: number;
  atlas_summary?: string;
  status?: string;
  session_id?: string;
  step_id?: string;
  details?: ContextItemDetails;
}

interface ContextListDropdownProps {
  contextItems: ContextItem[];
  onSelect: (item: ContextItem) => void;
  loading?: boolean;
  error?: string | null;
  visible: boolean;
}

const ContextListDropdown: React.FC<ContextListDropdownProps> = ({
  contextItems,
  onSelect,
  loading = false,
  error = null,
  visible,
}) => {
  const { t } = useTranslation();

  if (!visible) return null;

  // Get type icon
  const getTypeIcon = (type: string) => {
    const iconProps = { size: 14, className: "text-text-2" };
    switch (type) {
      case "task_info":
        return <ListTodo {...iconProps} />;
      case "repo_info":
        return <GitBranch {...iconProps} />;
      case "general_reference":
        return <Book {...iconProps} />;
      case "key":
        return <Key {...iconProps} />;
      case "image":
        return <ImageIcon {...iconProps} />;
      case "image_group":
        return <Images {...iconProps} />;
      default:
        return <File {...iconProps} />;
    }
  };

  // Get type tag
  const getTypeTag = (type: string) => {
    const typeMap: Record<string, { labelKey: string; color: string }> = {
      task_info: { labelKey: "contextList.task", color: "blue" },
      repo_info: { labelKey: "contextList.repo", color: "green" },
      general_reference: { labelKey: "contextList.ref", color: "purple" },
      key: { labelKey: "contextList.key", color: "orange" },
      image: { labelKey: "contextList.image", color: "pink" },
      image_group: { labelKey: "contextList.group", color: "cyan" },
    };

    const typeInfo = typeMap[type] || {
      labelKey: "contextList.unknown",
      color: "gray",
    };

    return (
      <span
        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium text-white`}
        style={{ backgroundColor: `var(--${typeInfo.color}-500)` }}
      >
        {t(typeInfo.labelKey)}
      </span>
    );
  };

  // Format time
  const formatTime = (timestamp: number) => {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  };

  // Render single context item
  const renderContextItem = (item: ContextItem) => (
    <div
      key={item.id}
      className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover}`}
      onClick={() => onSelect(item)}
    >
      <div className="flex flex-1 items-center gap-3">
        {getTypeIcon(item.type)}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-text-1">
              {item.title}
            </span>
            {getTypeTag(item.type)}
          </div>
          {item.when_to_use && (
            <p className="truncate text-[12px] text-text-3">
              {item.when_to_use}
            </p>
          )}
          {item.atlas_summary && (
            <p className="mt-1 truncate text-[12px] text-text-3">
              {item.atlas_summary}
            </p>
          )}
        </div>
      </div>

      {item.edited_at && (
        <div className="flex flex-shrink-0 items-center gap-1 text-[11px] text-text-3">
          <Clock size={DROPDOWN_ITEM.iconSize} />
          <span>{formatTime(item.edited_at)}</span>
        </div>
      )}
    </div>
  );

  return (
    <div
      className={`${DROPDOWN_CLASSES.panel} relative max-h-[312px] min-w-[300px] overflow-y-auto p-1 scrollbar-hide`}
    >
      {loading ? (
        <div className={DROPDOWN_CLASSES.listMessage}>
          <Loader2 size={DROPDOWN_ITEM.iconSize} className="animate-spin" />
          {t("status.loading")}
        </div>
      ) : error ? (
        <div className={DROPDOWN_CLASSES.listMessage}>
          <AlertCircle size={DROPDOWN_ITEM.iconSize} />
          {error}
        </div>
      ) : contextItems.length > 0 ? (
        <div className={DROPDOWN_CLASSES.itemsColumn}>
          {contextItems.map(renderContextItem)}
        </div>
      ) : (
        <div className={DROPDOWN_CLASSES.listMessage}>
          {t("contextList.noContextItemsFound")}
        </div>
      )}
    </div>
  );
};

export default ContextListDropdown;
