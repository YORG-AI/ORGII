import { describe, expect, it, vi } from "vitest";

import {
  createGitProfile,
  parseGitProfile,
  profileMatchesGlobal,
  serializeGitProfile,
} from "./gitProfiles";

describe("gitProfiles", () => {
  it("round-trips profile fields through the raw Git config editor", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "profile-1" });
    const profile = createGitProfile({
      label: "Work",
      name: 'Ada "A" Lovelace',
      email: "ada@example.com",
      signingKey: "ABC123",
      signCommits: true,
    });

    expect(parseGitProfile(serializeGitProfile(profile), profile)).toEqual(
      profile
    );
  });

  it("rejects config outside the supported identity surface", () => {
    const profile = {
      id: "profile-1",
      label: "Work",
      name: "Ada",
      email: "ada@example.com",
      signingKey: "",
      signCommits: false,
    };

    expect(() => parseGitProfile("[alias]\n  co = checkout", profile)).toThrow(
      "Unsupported Git config section"
    );
  });

  it("compares every applied field when detecting the active profile", () => {
    const profile = {
      id: "profile-1",
      label: "Work",
      name: "Ada",
      email: "ada@example.com",
      signingKey: "ABC123",
      signCommits: true,
    };

    expect(
      profileMatchesGlobal(profile, {
        name: "Ada",
        email: "ada@example.com",
        signing_key: "ABC123",
        sign_commits: true,
      })
    ).toBe(true);
    expect(
      profileMatchesGlobal(profile, {
        name: "Ada",
        email: "ada@example.com",
        signing_key: "ABC123",
        sign_commits: false,
      })
    ).toBe(false);
  });
});
