import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import VoiceRecordingBar from "./VoiceRecordingBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("VoiceRecordingBar", () => {
  it("names the add-content control when it is interactive", () => {
    const markup = renderToStaticMarkup(
      createElement(VoiceRecordingBar, {
        elapsedSeconds: 1,
        onAccept: vi.fn(),
        onAddContent: vi.fn(),
        onCancel: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="common:actions.add"');
    expect(markup).toContain('aria-hidden="false"');
  });
});
