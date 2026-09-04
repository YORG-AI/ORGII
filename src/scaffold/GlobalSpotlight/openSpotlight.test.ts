import { describe, expect, it } from "vitest";

import {
  createCollabOrgSpotlightRequest,
  createGitHubIssuesImportSpotlightRequest,
} from "./openSpotlight";

describe("createCollabOrgSpotlightRequest", () => {
  it("routes create and join presets through the typed Spotlight layer", () => {
    expect(
      createCollabOrgSpotlightRequest({ source: "cloud", mode: "join" })
    ).toEqual({
      query: "",
      layer: {
        kind: "collabOrg",
        context: { source: "cloud", mode: "join" },
      },
    });
  });
});

describe("createGitHubIssuesImportSpotlightRequest", () => {
  it("routes import context through the typed Spotlight layer", () => {
    expect(
      createGitHubIssuesImportSpotlightRequest({
        orgId: "org-a",
        repoName: "ORGII",
        repoPath: "/repos/orgii",
        repoUrl: "https://github.com/ORGII/ORGII.git",
      })
    ).toEqual({
      query: "",
      layer: {
        kind: "githubIssuesImport",
        context: {
          orgId: "org-a",
          repoName: "ORGII",
          repoPath: "/repos/orgii",
          repoUrl: "https://github.com/ORGII/ORGII.git",
        },
      },
    });
  });
});
