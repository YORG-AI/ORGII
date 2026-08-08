import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCollapsedSidebarButtonLeft,
  getCollapsedSidebarChromeOffset,
} from "./useCollapsedSidebarChromeOffset";

const { isMacOSMock } = vi.hoisted(() => ({
  isMacOSMock: vi.fn(),
}));

vi.mock("@src/util/platform/tauri", () => ({
  isMacOS: isMacOSMock,
}));

describe("getCollapsedSidebarChromeOffset", () => {
  beforeEach(() => {
    isMacOSMock.mockReset();
  });

  it("reserves native traffic-light space on macOS", () => {
    isMacOSMock.mockReturnValue(true);

    expect(getCollapsedSidebarButtonLeft()).toBe(88);
    expect(getCollapsedSidebarChromeOffset()).toBe(118);
  });

  it("reserves only the standalone sidebar toggle on Windows or Linux", () => {
    isMacOSMock.mockReturnValue(false);

    expect(getCollapsedSidebarButtonLeft()).toBe(8);
    expect(getCollapsedSidebarChromeOffset()).toBe(38);
  });
});
