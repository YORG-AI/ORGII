import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import HarnessConnectionsSection from "./HarnessConnectionsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/api/services/keyValidation", () => ({ saveKey: vi.fn() }));
vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn() },
}));
vi.mock(
  "@src/modules/MainApp/Integrations/KeyVault/CliClients/CredentialImport/InlineCredentialImport",
  () => ({
    default: () => createElement("div", { "data-testid": "credential-import" }),
  })
);
vi.mock("@src/scaffold/WizardSystem/variants/KeyVault", () => ({
  KeyVaultWizard: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("./HarnessConnectionEditor", () => ({
  default: ({ agentName }: { agentName: string }) =>
    createElement("div", { "data-testid": `harness-${agentName}` }),
}));
vi.mock("./useHarnessConnection", () => ({
  refreshHarnessConnections: vi.fn(),
}));

describe("HarnessConnectionsSection", () => {
  it("omits the helper description while retaining imports and both editors", () => {
    const markup = renderToStaticMarkup(
      createElement(HarnessConnectionsSection)
    );

    expect(markup).not.toContain("harnessConnections.description");
    expect(markup).toContain('data-testid="credential-import"');
    expect(markup).toContain('data-testid="harness-claude_code"');
    expect(markup).toContain('data-testid="harness-codex"');
  });
});
