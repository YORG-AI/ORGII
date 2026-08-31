/**
 * parseGitError — classification of raw git error text into GitErrorType.
 *
 * Fixtures are full, untruncated git output: git embeds branch names, file
 * paths, and URLs in its messages, and every historical misclassification
 * here came from a broad substring meeting exactly that embedded content.
 */
import { describe, expect, it } from "vitest";

import { parseGitError } from "../types";

function gitError(message: string, structured?: Record<string, unknown>) {
  const error = new Error(message);
  if (structured) Object.assign(error, structured);
  return error;
}

describe("parseGitError — structured error types", () => {
  it("prefers a structured errorType over text sniffing", () => {
    const parsed = parseGitError(
      gitError("error: failed to push some refs to 'origin'", {
        errorType: "protected_branch",
      })
    );
    expect(parsed.type).toBe("protected_branch");
  });

  it("accepts the snake_case error_type variant from the Rust backend", () => {
    const parsed = parseGitError(
      gitError("anything", { error_type: "non_fast_forward" })
    );
    expect(parsed.type).toBe("non_fast_forward");
  });

  it("ignores an unrecognized structured type and falls back to text", () => {
    const parsed = parseGitError(
      gitError("fatal: Authentication failed for 'https://github.com/a/b'", {
        errorType: "not-a-real-type",
      })
    );
    expect(parsed.type).toBe("authentication_failed");
  });

  it("ignores a structured 'none' and falls back to text", () => {
    const parsed = parseGitError(
      gitError("CONFLICT (content): Merge conflict in file.txt", {
        errorType: "none",
      })
    );
    expect(parsed.type).toBe("merge_conflicts");
  });
});

describe("parseGitError — real git output fixtures", () => {
  it("classifies a merge-overwrite refusal as uncommitted_changes", () => {
    const parsed = parseGitError(
      gitError(
        "error: Your local changes to the following files would be overwritten by merge:\n" +
          "\tsrc/main.rs\n" +
          "Please commit your changes or stash them before you merge.\n" +
          "Aborting"
      )
    );
    expect(parsed.type).toBe("uncommitted_changes");
  });

  it("classifies the rebase dirty-tree refusal as uncommitted_changes", () => {
    const parsed = parseGitError(
      gitError(
        "error: cannot pull with rebase: You have unstaged changes.\n" +
          "error: Please commit or stash them."
      )
    );
    expect(parsed.type).toBe("uncommitted_changes");
  });

  it("classifies a real merge conflict as merge_conflicts", () => {
    const parsed = parseGitError(
      gitError(
        "Auto-merging file.txt\n" +
          "CONFLICT (content): Merge conflict in file.txt\n" +
          "Automatic merge failed; fix conflicts and then commit the result."
      )
    );
    expect(parsed.type).toBe("merge_conflicts");
  });

  it("classifies a refused connection as network_error", () => {
    const parsed = parseGitError(
      gitError(
        "fatal: unable to access 'https://x.example/': Connection refused"
      )
    );
    expect(parsed.type).toBe("network_error");
  });

  it("returns unknown with a stringified message for non-Error input", () => {
    const parsed = parseGitError("plain string failure");
    expect(parsed).toEqual({
      type: "unknown",
      message: "plain string failure",
    });
  });
});

describe("parseGitError — regressions (previously misclassified)", () => {
  // A bare `includes("auth")` used to run first, so a branch NAME containing
  // "auth" turned a rejected push into authentication_failed and triggered
  // the credential-retry flow.
  it("classifies a rejected push on an auth-named branch as non_fast_forward", () => {
    const parsed = parseGitError(
      gitError(
        " ! [rejected]        feature/auth-login -> feature/auth-login (fetch first)\n" +
          "error: failed to push some refs to 'https://github.com/acme/app.git'\n" +
          "hint: Updates were rejected because the remote contains work that you do not\n" +
          "hint: have locally."
      )
    );
    expect(parsed.type).toBe("non_fast_forward");
  });

  // Git appends "failed to push some refs" to every rejection, so the
  // protected-branch family must win over non_fast_forward on full output.
  it("classifies a protected-branch rejection as protected_branch", () => {
    const parsed = parseGitError(
      gitError(
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\n" +
          " ! [remote rejected] main -> main (protected branch hook declined)\n" +
          "error: failed to push some refs to 'https://github.com/acme/app.git'"
      )
    );
    expect(parsed.type).toBe("protected_branch");
  });

  // "connection"/"timeout" used to be checked before the conflict arm, so a
  // conflict in a file whose PATH contains one of those words was reported
  // as a network error and no conflict dialog was shown.
  it("classifies a conflict in connection.ts as merge_conflicts", () => {
    const parsed = parseGitError(
      gitError(
        "Auto-merging src/api/connection.ts\n" +
          "CONFLICT (content): Merge conflict in src/api/connection.ts\n" +
          "Automatic merge failed; fix conflicts and then commit the result."
      )
    );
    expect(parsed.type).toBe("merge_conflicts");
  });

  it("classifies a DNS resolution failure as network_error", () => {
    const parsed = parseGitError(
      gitError(
        "fatal: unable to access 'https://github.com/acme/app.git/': " +
          "Could not resolve host: github.com"
      )
    );
    expect(parsed.type).toBe("network_error");
  });

  // "sso" only counts as a word: it must still catch real SAML enforcement
  // output but not fire from inside "lesson", "processor", or "associate".
  it("classifies real SAML enforcement output as authentication_failed", () => {
    const parsed = parseGitError(
      gitError(
        "remote: The `acme' organization has enabled or enforced SAML SSO. To access\n" +
          "remote: this repository, visit https://github.com/orgs/acme/sso"
      )
    );
    expect(parsed.type).toBe("authentication_failed");
  });

  it("does not treat sso-containing words as authentication failures", () => {
    const parsed = parseGitError(
      gitError(
        "error: pathspec 'docs/lesson-plan.md' did not match any file(s) known to git"
      )
    );
    expect(parsed.type).toBe("unknown");
  });

  // The HTTP error boundary emits "merge_conflict" (singular) while the
  // streaming layer emits "merge_conflicts"; both must be honored as
  // structured types rather than falling through to text sniffing.
  it("normalizes the singular merge_conflict structured type", () => {
    const parsed = parseGitError(
      gitError("Merge conflict: fix it", { error_type: "merge_conflict" })
    );
    expect(parsed.type).toBe("merge_conflicts");
  });
});
