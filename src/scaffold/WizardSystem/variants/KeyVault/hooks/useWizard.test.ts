// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useWizard } from "./useWizard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@src/hooks/ui", async () => {
  const { useState } = await import("react");
  return {
    useUndoableState: (initial: unknown) => {
      const [state, setState] = useState(initial);
      return { state, setState, reset: () => setState(initial) };
    },
  };
});

it("submits literal IDs and labels without draft rows or re-enabling disabled models", async () => {
  const submit = vi.fn();
  let wizard!: ReturnType<typeof useWizard>;
  function Harness() {
    const result = useWizard({
      onSubmit: submit,
      initialData: {
        agent_type: "custom_api",
        raw_key_input: "fixture-key",
        extracted_base_url: "https://example.invalid/v1",
        available_models: ["discovered"],
        custom_models: ["new-valid-model", "deployment-high", "new-row"],
        enabled_models: ["new-valid-model", "new-row"],
        model_aliases: [
          { alias: "new-valid-model", displayName: "My model" },
          { alias: "deployment-high", displayName: "Disabled model" },
          { alias: "new-row", displayName: "", isDraft: true },
        ],
      },
    });
    useEffect(() => {
      wizard = result;
    }, [result]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  act(() => wizard.submit());
  const request = submit.mock.calls[0][0];
  expect(request.available_models).toEqual([
    "discovered",
    "new-valid-model",
    "deployment-high",
  ]);
  expect(request.enabled_models).toEqual(["new-valid-model"]);
  expect(request.model_aliases).toEqual([
    { alias: "new-valid-model", display_name: "My model" },
    { alias: "deployment-high", display_name: "Disabled model" },
  ]);
  expect(
    request.model_variants.find(
      (v: { model: string }) => v.model === "deployment-high"
    )
  ).toEqual({
    model: "deployment-high",
    base_model: "deployment-high",
    fast: false,
  });
  act(() => wizard.updateData({ enabled_models: [] }));
  act(() => wizard.submit());
  expect(submit.mock.lastCall?.[0].enabled_models).toEqual([]);
  await act(async () => root.unmount());
});
