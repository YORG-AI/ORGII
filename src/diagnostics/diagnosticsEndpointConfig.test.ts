import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyDefaultDiagnosticsEndpoint, defaultDiagnosticsEndpoint } =
  require("../../scripts/tauri/diagnostics-endpoint.cjs") as {
    applyDefaultDiagnosticsEndpoint: (
      env: Record<string, string | undefined>,
      loadLocalToken?: () => string | undefined
    ) => Record<string, string | undefined>;
    defaultDiagnosticsEndpoint: () => string;
  };

describe("diagnostics build environment", () => {
  it("keeps local diagnostics offline when no upload credentials exist", () => {
    const env = applyDefaultDiagnosticsEndpoint({}, () => undefined);

    expect(env.ORGII_DIAGNOSTICS_ENDPOINT).toBeUndefined();
    expect(env.ORGII_DIAGNOSTICS_TOKEN).toBeUndefined();
  });

  it("adds the default endpoint when an upload token is supplied", () => {
    const env = applyDefaultDiagnosticsEndpoint({
      ORGII_DIAGNOSTICS_TOKEN: "test-token",
    });

    expect(env.ORGII_DIAGNOSTICS_ENDPOINT).toBe(defaultDiagnosticsEndpoint());
  });

  it("preserves an explicitly configured endpoint without requiring a token", () => {
    const env = applyDefaultDiagnosticsEndpoint({
      ORGII_DIAGNOSTICS_ENDPOINT: "http://127.0.0.1:8787/diagnostics",
    });

    expect(env.ORGII_DIAGNOSTICS_ENDPOINT).toBe(
      "http://127.0.0.1:8787/diagnostics"
    );
  });
});
