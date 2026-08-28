/**
 * DrillDownListPanel
 *
 * Generic left-panel drill-down shown when a full-page detail is active.
 * Renders a filterable list of items within the same category, plus a
 * back button and optional add action.
 */
import Button from "@/src/components/Button";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import {
  Add01Icon,
  ArrowLeft02Icon,
  HugeiconsIcon,
  Search01Icon,
} from "@src/icons";
import { ListPanelScrollArea } from "@src/modules/shared/layouts/blocks";

export interface DrillDownItem {
  id: string;
  name: string;
  icon?: React.ReactNode;
  /** Tailwind color class for the status dot (e.g. "bg-success-6") */
  statusDot?: string;
}

interface DrillDownListPanelProps {
  items: DrillDownItem[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  title: string;
  onAdd?: () => void;
  addLabel?: string;
}

const DrillDownListPanel: React.FC<DrillDownListPanelProps> = ({
  items,
  selectedId,
  loading,
  onSelect,
  onBack,
  title,
  onAdd,
  addLabel,
}) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(query));
  }, [items, searchQuery]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 flex-shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center rounded-md p-1 text-text-2 transition-colors hover:bg-fill-2 hover:text-text-1"
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            data-icon="arrow-left"
            size={16}
          />
        </button>
        <span className="text-[13px] font-medium text-text-1">{title}</span>
      </div>

      <div className="flex-shrink-0 px-3 pb-2">
        <Input
          prefix={
            <HugeiconsIcon
              icon={Search01Icon}
              data-icon="search"
              size={14}
              strokeWidth={1.75}
            />
          }
          placeholder={t("common:actions.search")}
          value={searchQuery}
          onChange={setSearchQuery}
          size="default"
        />
      </div>

      <ListPanelScrollArea listPaddingTop="none">
        {loading && items.length === 0 ? (
          <Placeholder variant="loading" />
        ) : filteredItems.length === 0 ? (
          <Placeholder variant="empty" title={t("common:status.noResults")} />
        ) : (
          <div className="flex flex-col gap-0.5 pb-2">
            {filteredItems.map((item) => {
              const isSelected = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors ${
                    isSelected
                      ? "bg-fill-2 font-medium text-text-1"
                      : "text-text-2 hover:bg-fill-1 hover:text-text-1"
                  }`}
                >
                  {item.icon && (
                    <span className="flex flex-shrink-0 items-center text-text-3">
                      {item.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.statusDot && (
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${item.statusDot}`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ListPanelScrollArea>

      {onAdd && (
        <div className="flex-shrink-0 p-3">
          <Button
            variant="primary"
            size="large"
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={16} />}
            long
            onClick={onAdd}
          >
            {addLabel ?? t("common:actions.add")}
          </Button>
        </div>
      )}
    </div>
  );
};

export default DrillDownListPanel;
