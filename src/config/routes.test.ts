import { ContentWritingIcon } from "@src/icons";

import { ROUTES, getIconComponentForPath, isWorkbenchPath } from "./routes";

describe("Workbench route ownership", () => {
  it("uses the writing glyph for My Station's Code Editor", () => {
    expect(getIconComponentForPath(ROUTES.workStation.code.path)).toBe(
      ContentWritingIcon
    );
  });

  it("owns Workstation and Settings without a global view mode", () => {
    expect(isWorkbenchPath(ROUTES.workStation.base.path)).toBe(true);
    expect(isWorkbenchPath(ROUTES.workStation.browser.path)).toBe(true);
    expect(isWorkbenchPath(ROUTES.app.settings.path)).toBe(true);
    expect(isWorkbenchPath(`${ROUTES.app.settings.path}/appearance`)).toBe(
      true
    );
  });

  it("keeps standalone app routes outside the Workbench shell", () => {
    expect(isWorkbenchPath(ROUTES.auth.login.path)).toBe(false);
    expect(isWorkbenchPath(ROUTES.app.selectRepo.path)).toBe(false);
    expect(isWorkbenchPath("/orgii/workstation-old")).toBe(false);
    expect(isWorkbenchPath("/orgii/app/settings-preview")).toBe(false);
  });

  it("does not expose a Home route", () => {
    expect("home" in ROUTES.app).toBe(false);
  });

  it("does not expose market routes (marketplace moved to the cloud)", () => {
    expect("market" in ROUTES.app).toBe(false);
  });
});
