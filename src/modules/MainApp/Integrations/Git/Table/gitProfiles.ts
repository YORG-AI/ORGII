import { atomWithStorage, createJSONStorage } from "jotai/utils";

export interface GitProfile {
  id: string;
  label: string;
  name: string;
  email: string;
  signingKey: string;
  signCommits: boolean;
}

export interface GitProfilesState {
  profiles: GitProfile[];
  activeProfileId: string | null;
}

export interface GitGlobalProfile {
  name: string;
  email: string;
  signing_key: string | null;
  sign_commits: boolean;
}

const gitProfilesStorage = createJSONStorage<GitProfilesState>(
  () => localStorage
);

export const gitProfilesAtom = atomWithStorage<GitProfilesState>(
  "orgii:git-profiles:v1",
  { profiles: [], activeProfileId: null },
  gitProfilesStorage,
  { getOnInit: true }
);

export function createGitProfile(
  values: Partial<Omit<GitProfile, "id">> = {}
): GitProfile {
  return {
    id: crypto.randomUUID(),
    label: values.label ?? "New profile",
    name: values.name ?? "",
    email: values.email ?? "",
    signingKey: values.signingKey ?? "",
    signCommits: values.signCommits ?? false,
  };
}

export function fromGlobalProfile(
  profile: GitGlobalProfile,
  label: string
): GitProfile {
  return createGitProfile({
    label,
    name: profile.name,
    email: profile.email,
    signingKey: profile.signing_key ?? "",
    signCommits: profile.sign_commits,
  });
}

export function toGlobalProfile(profile: GitProfile): GitGlobalProfile {
  return {
    name: profile.name.trim(),
    email: profile.email.trim(),
    signing_key: profile.signingKey.trim() || null,
    sign_commits: profile.signCommits,
  };
}

export function profileMatchesGlobal(
  profile: GitProfile,
  globalProfile: GitGlobalProfile
): boolean {
  const comparable = toGlobalProfile(profile);
  return (
    comparable.name === globalProfile.name.trim() &&
    comparable.email === globalProfile.email.trim() &&
    comparable.signing_key === (globalProfile.signing_key?.trim() || null) &&
    comparable.sign_commits === globalProfile.sign_commits
  );
}

function quoteGitConfigValue(value: string): string {
  return JSON.stringify(value);
}

export function serializeGitProfile(profile: GitProfile): string {
  const lines = [
    "[user]",
    `\tname = ${quoteGitConfigValue(profile.name)}`,
    `\temail = ${quoteGitConfigValue(profile.email)}`,
  ];
  if (profile.signingKey.trim()) {
    lines.push(`\tsigningkey = ${quoteGitConfigValue(profile.signingKey)}`);
  }
  lines.push("", "[commit]", `\tgpgsign = ${profile.signCommits}`);
  return lines.join("\n");
}

function parseGitConfigValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new Error("Invalid quoted Git config value");
    }
  }
  return trimmed;
}

export function parseGitProfile(
  rawConfig: string,
  current: GitProfile
): GitProfile {
  let section = "";
  const parsed = { ...current, signingKey: "", signCommits: false };

  for (const originalLine of rawConfig.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      if (section !== "user" && section !== "commit") {
        throw new Error(`Unsupported Git config section: [${section}]`);
      }
      continue;
    }

    const assignment = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!assignment || !section) {
      throw new Error(`Invalid Git config line: ${originalLine}`);
    }
    const key = assignment[1].toLowerCase();
    const value = parseGitConfigValue(assignment[2]);
    const compoundKey = `${section}.${key}`;
    switch (compoundKey) {
      case "user.name":
        parsed.name = value;
        break;
      case "user.email":
        parsed.email = value;
        break;
      case "user.signingkey":
        parsed.signingKey = value;
        break;
      case "commit.gpgsign":
        if (!/^(true|false|yes|no|on|off|1|0)$/i.test(value)) {
          throw new Error("commit.gpgsign must be true or false");
        }
        parsed.signCommits = /^(true|yes|on|1)$/i.test(value);
        break;
      default:
        throw new Error(`Unsupported Git profile key: ${compoundKey}`);
    }
  }

  if (!parsed.name.trim() || !parsed.email.trim()) {
    throw new Error("A Git profile requires both user.name and user.email");
  }
  return parsed;
}
