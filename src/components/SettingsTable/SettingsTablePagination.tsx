/**
 * Settings Table Pagination — reusable footer for SettingsTable.
 *
 * Icon-only prev/next buttons, page size Select with dropdown opening upward.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";

const PAGE_ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3";

export interface SettingsTablePaginationProps {
  pageIndex: number;
  pageSize: number;
  total: number;
  pageCount: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function SettingsTablePagination({
  pageIndex,
  pageSize,
  total,
  pageCount,
  canPreviousPage,
  canNextPage,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  className = "",
}: SettingsTablePaginationProps) {
  const { t } = useTranslation("common");

  const currentPage = pageIndex + 1;

  return (
    <div className={`grid w-full grid-cols-3 items-center py-1 ${className}`}>
      <span className="text-sm font-medium text-text-1">
        {t("pagination.totalItems", { count: total })}
      </span>

      <div className="flex items-center justify-center gap-2">
        <button
          className={PAGE_ICON_BUTTON}
          disabled={!canPreviousPage}
          onClick={() => onPageChange(currentPage - 2)}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-sm text-text-1">
          {t("pagination.pageOf", {
            current: currentPage,
            total: pageCount,
          })}
        </span>
        <button
          className={PAGE_ICON_BUTTON}
          disabled={!canNextPage}
          onClick={() => onPageChange(currentPage)}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="flex justify-end">
        <Select
          value={pageSize}
          onChange={(value) => onPageSizeChange(Number(value))}
          options={pageSizeOptions.map((size) => ({
            label: `${size} ${t("pagination.perPage")}`,
            value: size,
          }))}
          size="small"
          placement="top"
        />
      </div>
    </div>
  );
}
