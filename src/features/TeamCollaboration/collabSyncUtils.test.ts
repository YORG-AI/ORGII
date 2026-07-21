import { describe, expect, it } from "vitest";

import {
  COLLAB_SESSION_ACCESS_MODE,
  COLLAB_WORKSPACE_SCOPE,
} from "@src/store/collaboration/types";
import type {
  CollabOrgRecord,
  CollabSessionAccessSettings,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  createDefaultAccessSettings,
  isLocalRepoPath,
  isScopeKeyInScopes,
  normalizeRepoScopeKey,
  toRemoteMetadata,
} from "./collabSyncUtils";

describe("isLocalRepoPath", () => {
  it("recognizes Windows drive, UNC, and canonical verbatim paths", () => {
    expect(isLocalRepoPath("C:\\Repos\\ORGII")).toBe(true);
    expect(isLocalRepoPath("\\\\server\\share\\ORGII")).toBe(true);
    expect(isLocalRepoPath("\\\\?\\C:\\Repos\\ORGII")).toBe(true);
    expect(isLocalRepoPath("\\\\?\\UNC\\server\\share\\ORGII")).toBe(true);
    expect(isLocalRepoPath("github.com/yorgai/ORG2")).toBe(false);
  });
});

// Scope keys are normalized git-remote keys (design §8.3) — never paths.
const SCOPE_KEY = "github.com/acme/shared";

const ORG: CollabOrgRecord = {
  id: "org-1",
  name: "Team Alpha",
  repoScopes: [SCOPE_KEY],
  createdAt: "2026-07-01T00:00:00.000Z",
};

function createSession(overrides: Partial<Session>): Session {
  return {
    session_id: "session-1",
    status: "completed",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    repoPath: "/repo/shared",
    ...overrides,
  };
}

function createSettings(
  accessMode: CollabSessionAccessSettings["accessMode"],
  overrides: Partial<CollabSessionAccessSettings> = {}
): CollabSessionAccessSettings {
  return {
    orgId: ORG.id,
    memberId: "member-1",
    accessMode,
    workspaceScope: COLLAB_WORKSPACE_SCOPE.SELECTED_WORKSPACES,
    workspacePaths: [],
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toRemoteMetadata sharing fields", () => {
  const MEMBER = {
    id: "member-1",
    orgId: ORG.id,
    displayName: "Ada",
    avatar: { initials: "A", variant: "v" },
    role: "member",
    identityKind: "human",
    joinedAt: "2026-07-01T00:00:00.000Z",
  } as const;

  it("publishes typed external-history provenance and marks native sessions as ORGII", () => {
    const external = toRemoteMetadata(
      createSession({ session_id: "codexapp-thread-1" }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(external.origin).toEqual({
      kind: "external_history",
      source: "codex_app",
    });

    const native = toRemoteMetadata(
      createSession({ session_id: "sdeagent-thread-1" }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(native.origin).toEqual({ kind: "orgii" });
  });

  it("publishes org visibility and a replay level derived from the effective mode", () => {
    const replay = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(replay.visibility).toBe("org");
    expect(replay.replayLevel).toBe("replay");
    expect(replay.accessMode).toBe(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY);

    const metadataOnly = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY)
    );
    expect(metadataOnly.replayLevel).toBe("metadata");
  });

  it("publishes fork lineage with a root fallback, and omits it on non-forks", () => {
    const notAFork = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(notAFork.forkedFrom).toBeUndefined();

    const fork = toRemoteMetadata(
      createSession({
        forkedFrom: {
          orgId: ORG.id,
          sourceSessionId: "src-1",
          ownerMemberId: "m2",
          ownerDisplayName: "Bob",
          atCount: 3,
          forkedAt: "2026-07-04T00:00:00.000Z",
          rootSessionId: "root-0",
        },
      }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(fork.forkedFrom).toEqual({
      sourceSessionId: "src-1",
      rootSessionId: "root-0",
      ownerDisplayName: "Bob",
      forkedAt: "2026-07-04T00:00:00.000Z",
    });

    // Pre-lineage local fork (no recorded root): the source IS the root.
    const legacyFork = toRemoteMetadata(
      createSession({
        forkedFrom: {
          orgId: ORG.id,
          sourceSessionId: "src-1",
          ownerMemberId: "m2",
          ownerDisplayName: "Bob",
          atCount: 3,
          forkedAt: "2026-07-04T00:00:00.000Z",
        },
      }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(legacyFork.forkedFrom?.rootSessionId).toBe("src-1");
  });

  it("carries the per-session override into accessMode and replayLevel", () => {
    const overridden = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY, {
        sessionOverrides: {
          "session-1": COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
        },
      })
    );
    expect(overridden.accessMode).toBe(
      COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY
    );
    expect(overridden.replayLevel).toBe("metadata");
  });

  it("gates pre-shareSince sessions to OFF unless an override re-opens them", () => {
    const gated = toRemoteMetadata(
      createSession({ created_at: "2026-06-30T23:59:59.000Z" }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY, {
        shareSince: "2026-07-01T00:00:00.000Z",
      })
    );
    expect(gated.accessMode).toBe(COLLAB_SESSION_ACCESS_MODE.OFF);

    const reopened = toRemoteMetadata(
      createSession({ created_at: "2020-01-01T00:00:00.000Z" }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY, {
        shareSince: "2026-07-01T00:00:00.000Z",
        sessionOverrides: {
          "session-1": COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
        },
      })
    );
    expect(reopened.accessMode).toBe(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY);
  });

  it("gates to OFF when timestamps are unparseable (privacy-first)", () => {
    const unparseable = toRemoteMetadata(
      createSession({ created_at: "not-a-date" }),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY, {
        shareSince: "2026-07-01T00:00:00.000Z",
      })
    );
    expect(unparseable.accessMode).toBe(COLLAB_SESSION_ACCESS_MODE.OFF);
  });

  it("publishes 'restricted' when the owner explicitly picked it (M4b rule)", () => {
    const restricted = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY, {
        sessionVisibility: { "session-1": "restricted" },
      })
    );
    expect(restricted.visibility).toBe("restricted");
  });

  it("keeps 'org' visibility when the restricted entry targets another session", () => {
    const other = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY, {
        sessionVisibility: { "session-2": "restricted" },
      })
    );
    expect(other.visibility).toBe("org");
  });

  it("carries the resolved repoScopeKey on the wire record (design §8.3)", () => {
    const withKey = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY),
      SCOPE_KEY
    );
    expect(withKey.repoScopeKey).toBe(SCOPE_KEY);
    // repoPath stays as display metadata; the key is the matchable identity.
    expect(withKey.repoPath).toBe("/repo/shared");
  });

  it("omits repoScopeKey when the repo has no remote (null) or none was passed", () => {
    const noRemote = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY),
      null
    );
    expect(noRemote.repoScopeKey).toBeUndefined();
    const notPassed = toRemoteMetadata(
      createSession({}),
      ORG,
      MEMBER,
      createSettings(COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY)
    );
    expect(notPassed.repoScopeKey).toBeUndefined();
  });
});

describe("createDefaultAccessSettings", () => {
  it("defaults to OFF (design §6.3, fix S8 — sharing is opt-in)", () => {
    expect(createDefaultAccessSettings("org-1", "member-1").accessMode).toBe(
      COLLAB_SESSION_ACCESS_MODE.OFF
    );
  });
});

describe("normalizeRepoScopeKey", () => {
  it("collapses the three canonical remote forms to host/path (design §8.3)", () => {
    expect(normalizeRepoScopeKey("git@github.com:org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("https://github.com/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("ssh://git@github.com/org/x")).toBe(
      "github.com/org/x"
    );
  });

  it("normalizes remote-form variants: no .git, trailing slash, host case, http, git://", () => {
    expect(normalizeRepoScopeKey("https://github.com/org/x")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("https://github.com/org/x/")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("https://GitHub.COM/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("http://github.com/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("git://github.com/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("ssh://git@github.com/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("git@GitHub.com:org/x")).toBe(
      "github.com/org/x"
    );
    // scp-like with an absolute server path keeps a single leading slash.
    expect(normalizeRepoScopeKey("git@server.local:/srv/git/x.git")).toBe(
      "server.local/srv/git/x"
    );
  });

  it("drops the scheme's default port so an explicit :443/:80/:22 does not split the key", () => {
    expect(normalizeRepoScopeKey("https://github.com:443/org/x.git")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("http://github.com:80/org/x")).toBe(
      "github.com/org/x"
    );
    expect(normalizeRepoScopeKey("ssh://git@github.com:22/org/x")).toBe(
      "github.com/org/x"
    );
    // A non-default port is preserved (it identifies a distinct endpoint).
    expect(normalizeRepoScopeKey("https://ghe.corp:8443/org/x")).toBe(
      "ghe.corp:8443/org/x"
    );
  });

  it("folds owner/repo case on case-insensitive hosts but not elsewhere", () => {
    expect(normalizeRepoScopeKey("git@github.com:MyOrg/MyRepo.git")).toBe(
      "github.com/myorg/myrepo"
    );
    expect(normalizeRepoScopeKey("https://GitLab.com/Group/Sub/Repo")).toBe(
      "gitlab.com/group/sub/repo"
    );
    // A self-hosted (case-sensitive) host keeps path case.
    expect(normalizeRepoScopeKey("git@git.corp.local:Team/Repo.git")).toBe(
      "git.corp.local/Team/Repo"
    );
  });

  it("preserves path case on case-sensitive hosts (only the host is lowercased)", () => {
    // Self-hosted git servers are path-case-sensitive, so casing is kept.
    expect(normalizeRepoScopeKey("git@Git.Corp:Org/X.git")).toBe(
      "git.corp/Org/X"
    );
  });

  it("returns non-URL inputs trimmed minus trailing slashes", () => {
    expect(normalizeRepoScopeKey("  /repo/shared/  ")).toBe("/repo/shared");
    expect(normalizeRepoScopeKey("/repo/shared///")).toBe("/repo/shared");
    expect(normalizeRepoScopeKey("/Users/me/my.git.tools")).toBe(
      "/Users/me/my.git.tools"
    );
    expect(normalizeRepoScopeKey("")).toBe("");
    expect(normalizeRepoScopeKey("   ")).toBe("");
  });

  it("does not treat Windows drive letters as scp hosts", () => {
    expect(normalizeRepoScopeKey("C:\\repos\\x")).toBe("C:\\repos\\x");
  });

  it("is idempotent over already-normalized keys", () => {
    expect(normalizeRepoScopeKey("github.com/org/x")).toBe("github.com/org/x");
    expect(
      normalizeRepoScopeKey(normalizeRepoScopeKey("git@github.com:org/x.git"))
    ).toBe("github.com/org/x");
  });
});

describe("isScopeKeyInScopes", () => {
  it("matches remote keys across formats (scope stored ≠ format resolved)", () => {
    expect(
      isScopeKeyInScopes("git@github.com:org/x.git", ["github.com/org/x"])
    ).toBe(true);
    expect(
      isScopeKeyInScopes("https://github.com/org/x.git", [
        "ssh://git@github.com/org/x",
      ])
    ).toBe(true);
    expect(
      isScopeKeyInScopes("git@github.com:org/y.git", ["github.com/org/x"])
    ).toBe(false);
  });

  it("treats no-remote (null) and unresolved (undefined) keys as out of scope", () => {
    expect(isScopeKeyInScopes(null, ["github.com/org/x"])).toBe(false);
    expect(isScopeKeyInScopes(undefined, ["github.com/org/x"])).toBe(false);
    expect(isScopeKeyInScopes("", ["github.com/org/x"])).toBe(false);
  });

  it("rejects when the scope list is empty or missing", () => {
    expect(isScopeKeyInScopes("github.com/org/x", [])).toBe(false);
    expect(isScopeKeyInScopes("github.com/org/x", undefined)).toBe(false);
  });

  it("does not cross-match a local path against a remote scope key (resolution is owner-side)", () => {
    expect(isScopeKeyInScopes("/Users/me/x", ["github.com/org/x"])).toBe(false);
  });

  it("matches mixed scope lists on the right entry", () => {
    expect(
      isScopeKeyInScopes("https://github.com/org/x", [
        "github.com/org/legacy",
        "git@github.com:org/x.git",
      ])
    ).toBe(true);
  });
});
