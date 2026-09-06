// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useModelTableData } from "./useModelTableData";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("shows one editable row when discovery also includes a manually configured ID", async () => {
  let data!: ReturnType<typeof useModelTableData>;
  function Harness() {
    const result = useModelTableData({
      models: ["shared", "detected"],
      enabledModelsProp: ["shared"],
      customModels: ["shared"],
      modelAliases: [
        { alias: "shared", displayName: "Custom name", rowId: "stable-row" },
      ],
    });
    useEffect(() => {
      data = result;
    }, [result]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  expect(data.visibleFlatRows.filter((row) => row.model === "shared")).toEqual([
    { model: "shared", source: "custom", rowId: "stable-row" },
  ]);
  expect(data.visibleFlatRows.some((row) => row.model === "detected")).toBe(
    true
  );
  await act(async () => root.unmount());
});
