import { describe, expect, it } from "vitest";

import {
  PUSH_ADMISSION_DENIAL,
  decidePushAdmission,
} from "./org2CloudPushAdmission";

const ORG = "org-a";

function inputs(overrides: Partial<Parameters<typeof decidePushAdmission>[0]>) {
  return {
    orgId: ORG,
    session: { session_id: "claudecodeapp-1" },
    forkedFrom: undefined,
    tagged: false,
    ownedByOrg: false,
    shareIntent: false,
    ...overrides,
  } as Parameters<typeof decidePushAdmission>[0];
}

describe("decidePushAdmission", () => {
  it("admits a session explicitly owned by the org", () => {
    expect(decidePushAdmission(inputs({ ownedByOrg: true }))).toEqual({
      admitted: true,
    });
  });

  it("admits a tagged session", () => {
    expect(decidePushAdmission(inputs({ tagged: true }))).toEqual({
      admitted: true,
    });
  });

  it("admits an explicit share intent", () => {
    expect(decidePushAdmission(inputs({ shareIntent: true }))).toEqual({
      admitted: true,
    });
  });

  it("admits an imported history matched by repo scope", () => {
    expect(
      decidePushAdmission(
        inputs({
          session: {
            session_id: "claudecodeapp-1",
            repoPath: "/Users/me/org2",
            repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
          },
        })
      )
    ).toEqual({ admitted: true });
  });

  it("denies a spawned child even inside a scoped checkout", () => {
    // Subagent transcripts fold into their parent; publishing them floods
    // the team list with rows the receiving side cannot regroup.
    expect(
      decidePushAdmission(
        inputs({
          session: {
            session_id: "claudecodeapp-agent-a5",
            repoPath: "/Users/me/org2",
            repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
            parentSessionId: "claudecodeapp-1",
          },
        })
      )
    ).toEqual({
      admitted: false,
      denial: PUSH_ADMISSION_DENIAL.OWNERSHIP_GATE,
    });
  });

  it("denies an ordinary session with no ownership, tag, intent, or match", () => {
    expect(decidePushAdmission(inputs({}))).toEqual({
      admitted: false,
      denial: PUSH_ADMISSION_DENIAL.OWNERSHIP_GATE,
    });
  });

  it("admits a fork back to its own source org", () => {
    expect(decidePushAdmission(inputs({ forkedFrom: { orgId: ORG } }))).toEqual(
      { admitted: true }
    );
  });

  it("denies an untagged fork in any other org", () => {
    expect(
      decidePushAdmission(inputs({ forkedFrom: { orgId: "org-b" } }))
    ).toEqual({
      admitted: false,
      denial: PUSH_ADMISSION_DENIAL.FORK_OUTSIDE_SOURCE_ORG,
    });
  });

  it("lets an explicit tag override fork provenance for that org only", () => {
    expect(
      decidePushAdmission(
        inputs({ forkedFrom: { orgId: "org-b" }, tagged: true })
      )
    ).toEqual({ admitted: true });
  });

  it("keeps a tagged fork admitted without consulting the scope route", () => {
    // A fork carries no imported-history identity; the ownership gate must
    // not re-deny it after provenance already admitted it.
    expect(
      decidePushAdmission(
        inputs({
          forkedFrom: { orgId: ORG },
          session: { session_id: "agentsession-1" },
        })
      )
    ).toEqual({ admitted: true });
  });
});
