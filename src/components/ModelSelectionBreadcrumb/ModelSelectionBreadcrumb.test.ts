import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ModelSelectionBreadcrumb from ".";

describe("ModelSelectionBreadcrumb", () => {
  const modelLabel =
    "provider/model-with-a-very-long-unbroken-identifier-that-needs-to-wrap";

  it("wraps wide tooltip metadata inside its owning tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelSelectionBreadcrumb, {
        accountName: "account-with-a-very-long-name",
        modelLabel,
        wide: true,
      })
    );

    expect(markup).toContain("flex-wrap whitespace-normal");
    expect(markup).toContain("whitespace-normal break-all");
    expect(markup).not.toContain("whitespace-nowrap");
    expect(markup).not.toContain("max-w-[480px]");
  });

  it("keeps compact consumers truncated", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelSelectionBreadcrumb, { modelLabel })
    );

    expect(markup).toContain("truncate");
    expect(markup).not.toContain("flex-wrap whitespace-normal");
  });
});
