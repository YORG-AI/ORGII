/**
 * createGitOperationHandler — stream lifecycle and error-dialog behavior.
 *
 * Regression focus: a rejected stream setup used to leave the operation's
 * promise unsettled forever (stuck spinner), and an auth failure delivered
 * via onError opened the generic error dialog on top of the credential
 * dialog the caller's retry flow opens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { showGitErrorAndHandle } from "@src/hooks/git/gitErrorDialog";
import type { OperationContext } from "@src/types/workstation/gitOutputIntegration";

import { createGitOperationHandler } from "./createGitOperationHandler";

vi.mock("@src/hooks/git/gitErrorDialog", () => ({
  showGitErrorAndHandle: vi.fn(),
}));

const showDialog = vi.mocked(showGitErrorAndHandle);

const flushMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeContext(): OperationContext {
  return {
    repoPath: "/tmp/repo",
    repoId: "repo-1",
    cleanupRef: { current: null },
  } as OperationContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createGitOperationHandler", () => {
  it("settles with a failure when stream setup itself rejects", async () => {
    // Regression: without a rejection handler the promise never settled and
    // the operation's loading state was stuck for the session.
    const handler = createGitOperationHandler({
      streamFn: vi.fn().mockRejectedValue(new Error("backend not reachable")),
      operationName: "push",
      operationLabel: "Push",
    });

    const result = await handler(makeContext(), {});

    expect(result).toEqual({ success: false, errorType: "unknown" });
    await flushMacrotask();
    expect(showDialog).toHaveBeenCalledTimes(1);
  });

  it("resolves success from onComplete without a dialog", async () => {
    const handler = createGitOperationHandler({
      streamFn: vi.fn().mockImplementation(async (_params, callbacks) => {
        setTimeout(() => callbacks.onComplete(true, undefined), 0);
        return () => {};
      }),
      operationName: "pull",
      operationLabel: "Pull",
    });

    const result = await handler(makeContext(), {});

    expect(result).toEqual({ success: true, errorType: "none" });
    await flushMacrotask();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("does not stack a dialog on auth failures delivered via onError", async () => {
    // Regression: onComplete guarded auth failures (the caller's credential
    // retry opens its own dialog) but onError did not — two modals stacked.
    const handler = createGitOperationHandler({
      streamFn: vi.fn().mockImplementation(async (_params, callbacks) => {
        setTimeout(
          () =>
            callbacks.onError("Authentication failed", "authentication_failed"),
          0
        );
        return () => {};
      }),
      operationName: "push",
      operationLabel: "Push",
    });

    const result = await handler(makeContext(), {});

    expect(result).toEqual({
      success: false,
      errorType: "authentication_failed",
    });
    await flushMacrotask();
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("shows exactly one dialog for a non-auth onError", async () => {
    const handler = createGitOperationHandler({
      streamFn: vi.fn().mockImplementation(async (_params, callbacks) => {
        setTimeout(() => callbacks.onError("stream broke", "network_error"), 0);
        return () => {};
      }),
      operationName: "fetch",
      operationLabel: "Fetch",
    });

    const result = await handler(makeContext(), {});

    expect(result).toEqual({ success: false, errorType: "network_error" });
    await flushMacrotask();
    expect(showDialog).toHaveBeenCalledTimes(1);
  });

  it("closes the previous stream registered on the SAME context ref only", async () => {
    const previousCleanup = vi.fn();
    const context = makeContext();
    context.cleanupRef.current = previousCleanup;

    const otherContext = makeContext();
    const otherCleanup = vi.fn();
    otherContext.cleanupRef.current = otherCleanup;

    const handler = createGitOperationHandler({
      streamFn: vi.fn().mockImplementation(async (_params, callbacks) => {
        setTimeout(() => callbacks.onComplete(true, undefined), 0);
        return () => {};
      }),
      operationName: "push",
      operationLabel: "Push",
    });

    await handler(context, {});

    expect(previousCleanup).toHaveBeenCalledTimes(1);
    // A different operation's in-flight stream must be untouched — the
    // shared-ref version closed it and froze that operation forever.
    expect(otherCleanup).not.toHaveBeenCalled();
  });
});
