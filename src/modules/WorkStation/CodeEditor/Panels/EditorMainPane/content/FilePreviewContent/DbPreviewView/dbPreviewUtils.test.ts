import { describe, expect, it } from "vitest";

import type { TableInfo } from "@src/engines/DatabaseCore";

import {
  DB_PREVIEW_PAGE_SIZE,
  getDbPreviewPageRange,
  getNextDbPreviewSortState,
  withUpdatedDbPreviewTableRowCount,
} from "./dbPreviewUtils";

describe("dbPreviewUtils", () => {
  describe("getDbPreviewPageRange", () => {
    it("formats the first page range for DB toolbar pagination", () => {
      expect(getDbPreviewPageRange(1, DB_PREVIEW_PAGE_SIZE, 450)).toEqual({
        firstRowNumber: 1,
        lastRowNumber: 200,
        totalPages: 3,
        label: "1-200 / 450",
      });
    });

    it("formats partial and empty page ranges", () => {
      expect(getDbPreviewPageRange(3, DB_PREVIEW_PAGE_SIZE, 450)).toEqual({
        firstRowNumber: 401,
        lastRowNumber: 450,
        totalPages: 3,
        label: "401-450 / 450",
      });

      expect(getDbPreviewPageRange(1, DB_PREVIEW_PAGE_SIZE, 0)).toEqual({
        firstRowNumber: 0,
        lastRowNumber: 0,
        totalPages: 1,
        label: "0-0 / 0",
      });
    });

    it("keeps large totals readable", () => {
      expect(getDbPreviewPageRange(2, DB_PREVIEW_PAGE_SIZE, 1200)).toEqual({
        firstRowNumber: 201,
        lastRowNumber: 400,
        totalPages: 6,
        label: "201-400 / 1,200",
      });
    });
  });

  describe("getNextDbPreviewSortState", () => {
    it("starts sorting a column ascending", () => {
      expect(getNextDbPreviewSortState(null, "asc", "name")).toEqual({
        columnId: "name",
        direction: "asc",
      });
    });

    it("toggles the same ascending column to descending", () => {
      expect(getNextDbPreviewSortState("name", "asc", "name")).toEqual({
        columnId: "name",
        direction: "desc",
      });
    });

    it("resets to ascending when switching columns", () => {
      expect(getNextDbPreviewSortState("name", "desc", "created_at")).toEqual({
        columnId: "created_at",
        direction: "asc",
      });
    });
  });

  describe("withUpdatedDbPreviewTableRowCount", () => {
    const tables: TableInfo[] = [
      { name: "users", type: "table" },
      { name: "active_users", type: "view", rowCount: 8 },
    ];

    it("updates only the selected table with the loaded total count", () => {
      expect(withUpdatedDbPreviewTableRowCount(tables, "users", 321)).toEqual([
        { name: "users", type: "table", rowCount: 321 },
        { name: "active_users", type: "view", rowCount: 8 },
      ]);
    });

    it("preserves tables when the backend omits totalCount", () => {
      expect(
        withUpdatedDbPreviewTableRowCount(tables, "users", undefined)
      ).toBe(tables);
    });
  });
});
