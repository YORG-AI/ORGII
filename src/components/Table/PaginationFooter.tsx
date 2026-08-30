import Button from "@/src/components/Button";
import React from "react";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { ArrowLeft01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import type { PaginationRenderContext, TablePagination } from "./types";

interface PaginationFooterProps {
  pagination: TablePagination;
  pageIndex: number;
  pageSize: number;
  total: number;
  pageCount: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  /** Expects 1-based page number */
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  renderPagination?: (ctx: PaginationRenderContext) => React.ReactNode;
}

export const PaginationFooter: React.FC<PaginationFooterProps> = ({
  pagination,
  pageIndex,
  pageSize,
  total,
  pageCount,
  canPreviousPage,
  canNextPage,
  onPageChange,
  onPageSizeChange,
  renderPagination,
}) => {
  const currentPage = pageIndex + 1;

  if (renderPagination) {
    return (
      <>
        {renderPagination({
          pageIndex,
          pageSize,
          total,
          pageCount,
          canPreviousPage,
          canNextPage,
          onPageChange: (newIndex) => onPageChange(newIndex + 1),
          onPageSizeChange,
        })}
      </>
    );
  }

  return (
    <div className="table-pagination">
      <div className="table-pagination-left">
        {pagination.showSizeChanger && (
          <Select
            value={pageSize}
            onChange={(value) => onPageSizeChange(Number(value))}
            options={(pagination.pageSizeOptions || [10, 20, 50, 100]).map(
              (optionSize) => ({
                label: `${optionSize} / page`,
                value: optionSize,
              })
            )}
            size="small"
            className="table-pagination-size"
          />
        )}
        <span className="table-pagination-total">Total {total} items</span>
      </div>

      <div className="table-pagination-right">
        <Button
          size="small"
          disabled={!canPreviousPage}
          onClick={() => onPageChange(currentPage - 1)}
          icon={
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              data-icon="chevron-left"
              size={16}
            />
          }
        />

        <span className="table-pagination-info">
          Page {currentPage} of {pageCount}
        </span>

        <Button
          size="small"
          disabled={!canNextPage}
          onClick={() => onPageChange(currentPage + 1)}
          icon={
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={16}
            />
          }
        />

        {pagination.showQuickJumper && (
          <div className="table-pagination-jumper">
            Go to
            <Input
              type="number"
              min={1}
              max={pageCount}
              defaultValue={String(currentPage)}
              size="small"
              className="!w-16"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const page = Number((event.target as HTMLInputElement).value);
                  if (page >= 1 && page <= pageCount) {
                    onPageChange(page);
                  }
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
