// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeRequest } from "./requestHandler";

const mocks = vi.hoisted(() => ({
  axios: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock("axios", () => ({
  default: Object.assign(mocks.axios, { isCancel: mocks.isCancel }),
}));

vi.mock("@src/diagnostics/runtimeCounters", () => ({
  recordDiagnosticsHttp: vi.fn(),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@src/util/config/headers", () => ({
  getGlobalCommonHeaders: () => ({}),
}));

vi.mock("./errorHandling", () => ({
  buildErrorMessage: vi.fn(() => "request failed"),
  showErrorNotification: vi.fn(),
  showResponseErrorNotification: vi.fn(),
  showServerErrorNotification: vi.fn(),
  showTimeoutErrorNotification: vi.fn(),
  showWorkflowErrorNotification: vi.fn(),
}));

vi.mock("./tokenRefresh", () => ({
  getOrRefreshHostedToken: vi.fn(async () => null),
}));

describe("request-handler authentication isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("reports an agent-realm 401 without clearing hosted identity", async () => {
    localStorage.setItem("hosted_access_token", "hosted-stays-ready");
    const sessionExpiredListener = vi.fn();
    window.addEventListener("orgii:session-expired", sessionExpiredListener);
    const onNoAuth = vi.fn();
    mocks.axios.mockRejectedValueOnce({
      response: {
        status: 401,
        data: { detail: "Expired token" },
      },
    });

    const result = await makeRequest(
      "GET",
      "/agent-only-resource",
      "agent",
      undefined,
      { onNoAuth }
    );

    expect(onNoAuth).toHaveBeenCalledWith({
      realm: "agent_runtime",
      sessionId: null,
      target: "agent",
      status: 401,
      reason: "credential_expired",
    });
    expect(localStorage.getItem("hosted_access_token")).toBe(
      "hosted-stays-ready"
    );
    expect(sessionExpiredListener).not.toHaveBeenCalled();
    expect(result?.data.title).toBe("Authentication Required");

    window.removeEventListener("orgii:session-expired", sessionExpiredListener);
  });
});
