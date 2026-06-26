/**
 * Unit tests for the pure helpers inside gitErrorDialog.ts.
 *
 * Tests inferErrorTypeFromText, extractPrimaryErrorDetail, and buildGitErrorInfo
 * without invoking Tauri dialogs.
 */
import { describe, expect, it } from "vitest";

import {
  type GitErrorDialogOptions,
  buildGitErrorInfo,
} from "../gitErrorDialog";

// ---------------------------------------------------------------------------
// Helpers — we test through buildGitErrorInfo which calls inferErrorTypeFromText
// internally, and we also use extractPrimaryErrorDetail indirectly via the
// buildGitErrorInfo commandOutput field.
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<GitErrorDialogOptions>
): GitErrorDialogOptions {
  return {
    operation: "push",
    errorType: "unknown",
    errorMessage: "push failed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildGitErrorInfo — errorType inference
// ---------------------------------------------------------------------------

describe("buildGitErrorInfo — error type inference (errorType: 'unknown')", () => {
  it("infers non_fast_forward for push with 'non-fast-forward' in output", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        commandOutput: "error: failed to push some refs\nnon-fast-forward",
      })
    );
    expect(info.errorType).toBe("non_fast_forward");
  });

  it("infers non_fast_forward for push with 'updates were rejected'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        commandOutput: "Updates were rejected because the remote contains work",
      })
    );
    expect(info.errorType).toBe("non_fast_forward");
  });

  it("infers protected_branch for push with 'protected branch'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        commandOutput: "remote: error: Protected branch rules violated",
      })
    );
    expect(info.errorType).toBe("protected_branch");
  });

  it("infers uncommitted_changes for pull with 'would be overwritten'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "pull",
        commandOutput:
          "Your local changes to the following files would be overwritten by merge",
      })
    );
    expect(info.errorType).toBe("uncommitted_changes");
  });

  it("infers uncommitted_changes for checkout with 'would be overwritten by checkout'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "checkout",
        commandOutput:
          "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.",
      })
    );
    expect(info.errorType).toBe("uncommitted_changes");
  });

  it("infers uncommitted_changes for checkout with 'please commit your changes or stash them'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "checkout",
        commandOutput:
          "Please commit your changes or stash them before you switch branches.",
      })
    );
    expect(info.errorType).toBe("uncommitted_changes");
  });

  it("infers uncommitted_changes for pull rebase with unstaged changes", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "pull",
        commandOutput:
          "error: cannot pull with rebase: You have unstaged changes.\nerror: Please commit or stash them.",
      })
    );
    expect(info.errorType).toBe("uncommitted_changes");
  });

  it("infers merge_conflicts for pull with 'automatic merge failed'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "pull",
        commandOutput:
          "Automatic merge failed; fix conflicts and then commit the result.",
      })
    );
    expect(info.errorType).toBe("merge_conflicts");
  });

  it("infers remote_branch_deleted for fetch with '[deleted]'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "fetch",
        commandOutput: " - [deleted] origin/old-branch",
      })
    );
    expect(info.errorType).toBe("remote_branch_deleted");
  });

  it("infers authentication_failed for any operation with 'authentication failed'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        errorMessage: "Authentication failed for 'https://github.com/...'",
      })
    );
    expect(info.errorType).toBe("authentication_failed");
  });

  it("infers network_error for any operation with 'could not resolve host'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "fetch",
        errorMessage: "fatal: could not resolve host: github.com",
      })
    );
    expect(info.errorType).toBe("network_error");
  });

  it("infers permission_denied for any operation with 'permission denied'", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        errorMessage: "remote: Permission denied to user/repo.",
      })
    );
    expect(info.errorType).toBe("permission_denied");
  });

  it("falls back to unknown when no pattern matches", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        errorMessage: "some completely unrecognised error",
      })
    );
    expect(info.errorType).toBe("unknown");
  });
});

describe("buildGitErrorInfo — preserves known errorType", () => {
  it("passes through a non-unknown errorType unchanged", () => {
    const info = buildGitErrorInfo(
      makeOptions({
        operation: "push",
        errorType: "network_error",
        errorMessage: "push failed",
      })
    );
    expect(info.errorType).toBe("network_error");
  });
});

describe("buildGitErrorInfo — commandOutput fallback", () => {
  it("falls back to errorMessage when commandOutput is absent", () => {
    const info = buildGitErrorInfo(
      makeOptions({ errorMessage: "detailed error message" })
    );
    expect(info.commandOutput).toBe("detailed error message");
  });

  it("uses commandOutput when provided", () => {
    const info = buildGitErrorInfo(
      makeOptions({ errorMessage: "short", commandOutput: "long output here" })
    );
    expect(info.commandOutput).toBe("long output here");
  });
});

describe("buildGitErrorInfo — timestamp", () => {
  it("uses provided timestamp", () => {
    const ts = new Date("2026-01-01T00:00:00Z");
    const info = buildGitErrorInfo(makeOptions({ timestamp: ts }));
    expect(info.timestamp).toBe(ts);
  });

  it("falls back to a recent Date when timestamp is omitted", () => {
    const before = Date.now();
    const info = buildGitErrorInfo(makeOptions({}));
    expect(info.timestamp.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("buildGitErrorInfo — basic fields", () => {
  it("preserves operation name", () => {
    const info = buildGitErrorInfo(makeOptions({ operation: "merge" }));
    expect(info.operation).toBe("merge");
  });

  it("preserves errorMessage", () => {
    const info = buildGitErrorInfo(makeOptions({ errorMessage: "my error" }));
    expect(info.errorMessage).toBe("my error");
  });
});
