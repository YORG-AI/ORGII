// @vitest-environment jsdom
import { Provider } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GitHubIssuesImportForm from "./GitHubIssuesImportForm";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/api/http/integrations/syncConnections", () => ({
  STORY_SYNC_ADAPTER: { GITHUB: "github" },
  syncConnectionsApi: { list: vi.fn().mockResolvedValue([]) },
}));

describe("GitHubIssuesImportForm", () => {
  it("renders repository defaults inside the shared Spotlight form", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Provider,
        null,
        createElement(GitHubIssuesImportForm, {
          repoName: "ORGII",
          repoPath: "/repos/orgii",
          repoUrl: "https://github.com/ORGII/ORGII.git",
          onCancel: vi.fn(),
          onImported: vi.fn(),
        })
      )
    );

    expect(markup).toContain('data-testid="github-issues-import-spotlight"');
    expect(markup).toContain('data-testid="github-issues-import-form"');
    expect(markup).toContain('class="spotlight-search-bar');
    expect(markup).toContain('value="ORGII issues"');
    expect(markup).toContain('value="ORGII/ORGII"');
    expect(markup).toContain("projects:githubIssuesImport.loadingConnections");
    expect(markup).not.toContain("github-issues-import-wizard");
  });
});
