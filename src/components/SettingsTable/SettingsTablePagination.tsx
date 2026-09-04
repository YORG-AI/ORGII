/**
 * Settings Table Pagination — reusable footer for SettingsTable.
 *
 * First/prev/next/last icon buttons around a page Select, plus a page size
 * Select with dropdown opening upward. A custom `pageLabel` replaces the page
 * Select with a static label and hides the jump controls (first/last), for
 * consumers whose paging model cannot jump at all. Remotely-fed tables that
 * page locally over loaded items (e.g. GitHub work items) should instead pass
 * `openEndedPageCount`: jumps stay enabled across loaded pages and the total
 * renders as "N+" while more remote pages exist.
 */
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import {
  ArrowLeft01Icon,
  ArrowLeftDoubleIcon,
  ArrowRight01Icon,
  ArrowRightDoubleIcon,
  HugeiconsIcon,
} from "@src/icons";

/** Shared prev/next icon-button style for table/list pagination footers. */
export const PAGE_ICON_BUTTON =
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
  totalLabel?: ReactNode;
  pageLabel?: ReactNode;
  /** When true, `pageCount` only covers the pages loaded so far (more remote
   *  pages exist): page labels render the total as "N+" and the last button
   *  jumps to the last loaded page. */
  openEndedPageCount?: boolean;
  showTotal?: boolean;
  showPageSize?: boolean;
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
  totalLabel,
  pageLabel,
  openEndedPageCount = false,
  showTotal = false,
  showPageSize = true,
  className = "",
}: SettingsTablePaginationProps) {
  const { t } = useTranslation("common");

  const currentPage = pageIndex + 1;
  const canJump = pageLabel === undefined;
  const safePageCount = Math.max(pageCount, 1);

  const totalPagesDisplay = openEndedPageCount
    ? `${safePageCount}+`
    : safePageCount;

  const pageOptions = useMemo(() => {
    if (!canJump) return [];
    return Array.from({ length: safePageCount }, (_, index) => ({
      label: t("pagination.pageOf", {
        current: index + 1,
        total: totalPagesDisplay,
      }),
      value: index + 1,
    }));
  }, [canJump, safePageCount, t, totalPagesDisplay]);

  return (
    <div className={`grid w-full grid-cols-3 items-center py-1 ${className}`}>
      <div className="flex justify-start">
        {showPageSize ? (
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
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-1">
        {canJump ? (
          <button
            className={PAGE_ICON_BUTTON}
            disabled={!canPreviousPage}
            onClick={() => onPageChange(0)}
            aria-label={t("pagination.firstPage")}
            title={t("pagination.firstPage")}
          >
            <HugeiconsIcon
              icon={ArrowLeftDoubleIcon}
              data-icon="chevrons-left"
              size={14}
            />
          </button>
        ) : null}
        <button
          className={PAGE_ICON_BUTTON}
          disabled={!canPreviousPage}
          onClick={() => onPageChange(currentPage - 2)}
          aria-label={t("pagination.previousPage")}
          title={t("pagination.previousPage")}
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            data-icon="chevron-left"
            size={14}
          />
        </button>
        {canJump ? (
          <Select
            value={Math.min(currentPage, safePageCount)}
            options={pageOptions}
            onChange={(value) => onPageChange(Number(value) - 1)}
            size="small"
            placement="top"
            dropdownWidthMode="auto"
            ariaLabel={t("pagination.selectPage")}
          />
        ) : (
          <span className="text-xs text-text-1">{pageLabel}</span>
        )}
        <button
          className={PAGE_ICON_BUTTON}
          disabled={!canNextPage}
          onClick={() => onPageChange(currentPage)}
          aria-label={t("pagination.nextPage")}
          title={t("pagination.nextPage")}
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            data-icon="chevron-right"
            size={14}
          />
        </button>
        {canJump ? (
          <button
            className={PAGE_ICON_BUTTON}
            disabled={currentPage >= safePageCount}
            onClick={() => onPageChange(safePageCount - 1)}
            aria-label={t("pagination.lastPage")}
            title={t("pagination.lastPage")}
          >
            <HugeiconsIcon
              icon={ArrowRightDoubleIcon}
              data-icon="chevrons-right"
              size={14}
            />
          </button>
        ) : null}
      </div>

      <span className="text-right text-xs font-medium text-text-1">
        {showTotal
          ? (totalLabel ?? t("pagination.totalItems", { count: total }))
          : null}
      </span>
    </div>
  );
}
