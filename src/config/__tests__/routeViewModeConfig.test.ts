import {
  getAppModeForRoute,
  getRouteConfig,
  getRouteDescription,
  getViewModeForRoute,
  shouldSaveToPreviousRoute,
} from "../routeViewModeConfig";
import { APP_HOME_ROUTES } from "../routes";

describe("getAppModeForRoute", () => {
  it("maps workstation subpaths to app modes", () => {
    expect(getAppModeForRoute("/orgii/workstation")).toBe("code");
    expect(getAppModeForRoute("/orgii/workstation/browser")).toBe("browser");
    expect(getAppModeForRoute("/orgii/workstation/chat")).toBe("chat");
    expect(getAppModeForRoute("/orgii/workstation/project")).toBe("project");
  });

  it("defaults to code for unknown paths", () => {
    expect(getAppModeForRoute("/orgii/market/foo")).toBe("code");
    expect(getAppModeForRoute("/orgii/workstation/unknown")).toBe("code");
    // Legacy /workstation/launchpad path no longer carries its own
    // app mode — the dashboard moved into the Code Editor surface.
    expect(getAppModeForRoute("/orgii/workstation/launchpad")).toBe("code");
  });
});

describe("getViewModeForRoute", () => {
  it("uses prefix fallbacks when no exact route matches", () => {
    expect(getViewModeForRoute("/orgii/workstation/extra")).toBe("workStation");
  });

  it("defaults other /orgii paths to mainApp", () => {
    expect(getViewModeForRoute("/orgii/market/foo")).toBe("mainApp");
  });
});

describe("getRouteDescription", () => {
  it("returns a description when pattern config matches", () => {
    const description = getRouteDescription("/orgii/workstation/code");
    expect(description).toEqual(expect.any(String));
    expect(description!.length).toBeGreaterThan(0);
  });
});

describe("getRouteConfig", () => {
  it("returns exact route metadata from routes.ts when path matches", () => {
    const config = getRouteConfig(APP_HOME_ROUTES.start.path);
    expect(config).not.toBeNull();
    expect(config?.match).toBe("exact");
    expect(config?.viewMode).toBe("mainApp");
    expect(config?.saveToPreviousRoute).toBe(true);
  });

  it("falls back to prefix patterns when no static route matches", () => {
    const config = getRouteConfig("/orgii/market/extra/deep");
    expect(config).not.toBeNull();
    expect(config?.match).toBe("prefix");
    expect(config?.viewMode).toBe("mainApp");
    expect(config?.pattern).toBe("/orgii/");
  });
});

describe("shouldSaveToPreviousRoute", () => {
  it("is true for app routes and false for workstation prefix fallbacks", () => {
    expect(shouldSaveToPreviousRoute("/orgii/workstation/extra")).toBe(false);
  });
});
