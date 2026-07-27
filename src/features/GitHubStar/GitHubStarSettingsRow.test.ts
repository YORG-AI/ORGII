import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GitHubStarSettingsRow } from "./GitHubStarSettingsRow";
import type { GitHubStarController } from "./useGitHubStarController";

const { useControllerMock } = vi.hoisted(() => ({
  useControllerMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./useGitHubStarController", () => ({
  useGitHubStarController: useControllerMock,
}));

function controller(
  state: GitHubStarController["state"]
): GitHubStarController {
  return {
    state,
    source: "settings",
    confirmStar: vi.fn(),
    openFallback: vi.fn(),
    retry: vi.fn(),
  };
}

describe("GitHubStarSettingsRow", () => {
  it("renders an accessible loading status", () => {
    useControllerMock.mockReturnValue(controller({ status: "loading" }));

    const markup = renderToStaticMarkup(createElement(GitHubStarSettingsRow));

    expect(markup).toContain("general.githubStar.label");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("general.githubStar.loading");
  });

  it("renders a confirmed state with a polite status", () => {
    useControllerMock.mockReturnValue(controller({ status: "starred" }));

    const markup = renderToStaticMarkup(
      createElement(GitHubStarSettingsRow, {
        source: "reminder",
        onConfirmedStarred: vi.fn(),
      })
    );

    expect(markup).toContain("general.githubStar.thanks");
    expect(markup).toContain('aria-busy="false"');
    expect(useControllerMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: "reminder" })
    );
  });
});
