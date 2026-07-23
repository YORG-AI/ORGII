import { ROUTES, isWorkbenchPath } from "../routes";

describe("Workbench route ownership", () => {
  it("owns Workstation, Settings, and pane launchers without a global view mode", () => {
    expect(isWorkbenchPath(ROUTES.workStation.base.path)).toBe(true);
    expect(isWorkbenchPath(ROUTES.workStation.browser.path)).toBe(true);
    expect(isWorkbenchPath(ROUTES.app.settings.path)).toBe(true);
    expect(isWorkbenchPath(ROUTES.app.changelog.path)).toBe(true);
    expect(isWorkbenchPath(`${ROUTES.app.settings.path}/appearance`)).toBe(
      true
    );
  });

  it("keeps standalone app routes outside the Workbench shell", () => {
    expect(isWorkbenchPath(ROUTES.auth.login.path)).toBe(false);
    expect(isWorkbenchPath(ROUTES.app.selectRepo.path)).toBe(false);
    expect(isWorkbenchPath(ROUTES.app.market.tokenMarket.path)).toBe(false);
    expect(isWorkbenchPath("/orgii/workstation-old")).toBe(false);
    expect(isWorkbenchPath("/orgii/app/settings-preview")).toBe(false);
  });

  it("does not expose a Home route", () => {
    expect("home" in ROUTES.app).toBe(false);
  });
});
