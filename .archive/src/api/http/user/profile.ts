/**
 * User Profile API
 *
 * Server-side profile endpoints. Most profile data is now fetched locally
 * via Tauri Rust (see githubLocal.ts + useUserProfile hook).
 *
 * Only getPublicProfile remains — used for viewing other users' profiles
 * via the hosted service.
 */
import type { UserProfileData } from "@src/types/core/user";

import { getHostedServiceApi, putHostedServiceApi } from "../client";

export interface ExperienceItem {
  company: string;
  title: string;
  start_date?: string;
  end_date?: string;
  description?: string;
  is_current?: boolean;
}

export interface EducationItem {
  school: string;
  degree?: string;
  field?: string;
  start_date?: string;
  end_date?: string;
}

export interface ProfileUpdateRequest {
  display_name?: string;
  avatar_url?: string;
  date_of_birth?: string;
  gender?: string;
  bio?: string;
  role?: string;
  location?: string;
  timezone?: string;
  skills?: string[];
  experience?: ExperienceItem[];
  education?: EducationItem[];
  social_links?: Record<string, string>;
  is_public?: boolean;
  total_repos?: number;
  public_repos?: number;
  private_repos?: number;
  total_commits?: number;
  years_active?: number;
  commits_last_year?: number;
  commits_last_month?: number;
  avg_commits_per_week?: number;
  language_breakdown?: Record<
    string,
    { percentage: number; bytes: number; repos: number }
  >;
  primary_language?: string;
  secondary_language?: string;
  tertiary_language?: string;
  primary_specialty?: string;
  specialty_confidence?: number;
  specialty_scores?: Record<string, number>;
  commits_by_year?: Record<string, number>;
  connected_sources?: Record<string, boolean>;
  source_usernames?: Record<string, string>;
}

export interface FullProfileData extends UserProfileData {
  date_of_birth?: string;
  gender?: string;
  bio?: string;
  role?: string;
  location?: string;
  timezone?: string;
  skills: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  social_links: Record<string, string>;
  is_public: boolean;
}

type ProfileRawData = Record<string, unknown>;

/**
 * Normalize backend profile response to match frontend expectations.
 * Kept for getPublicProfile which still reads from the server DB cache.
 */
function normalizeProfileData(data: unknown): UserProfileData {
  if (!data || typeof data !== "object") {
    throw new Error("Profile data is empty or invalid");
  }

  const raw = data as Record<string, unknown>;

  const commitsByYear = (raw.commits_by_year as Record<string, number>) || {};
  const yearsActiveArray = Object.keys(commitsByYear).sort();

  const backendTopLanguages =
    (raw.top_languages as Array<{
      language: string;
      percentage: number;
      repos_count?: number;
      repos?: number;
      bytes: number;
    }>) || [];

  const topLanguages = backendTopLanguages.map((lang) => ({
    language: lang.language,
    percentage: lang.percentage,
    repos_count: lang.repos_count ?? lang.repos ?? 0,
    bytes: lang.bytes,
  }));

  return {
    user_id: raw.user_id as string,
    display_name: raw.display_name as string | undefined,
    avatar_url: raw.avatar_url as string | undefined,
    source_usernames: raw.source_usernames as
      | Record<string, string>
      | undefined,

    total_repos: (raw.total_repos as number) || 0,
    public_repos: (raw.public_repos as number) || 0,
    private_repos: (raw.private_repos as number) || 0,

    total_commits: (raw.total_commits as number) || 0,
    years_active: (raw.years_active as number) || yearsActiveArray.length,
    first_commit_date: raw.first_commit_date as string | undefined,
    last_commit_date: raw.last_commit_date as string | undefined,
    commits_last_year: (raw.commits_last_year as number) || 0,
    commits_last_month: (raw.commits_last_month as number) || 0,
    avg_commits_per_week: (raw.avg_commits_per_week as number) || 0,

    years_active_array: yearsActiveArray,
    commits_by_year: commitsByYear,

    top_languages: topLanguages,
    language_breakdown:
      raw.language_breakdown as UserProfileData["language_breakdown"],
    primary_language: raw.primary_language as string | undefined,

    specialty: {
      primary:
        ((raw.specialty as Record<string, unknown>)
          ?.primary as UserProfileData["specialty"]["primary"]) || "other",
      confidence:
        ((raw.specialty as Record<string, unknown>)?.confidence as number) || 0,
      scores:
        ((raw.specialty as Record<string, unknown>)
          ?.scores as UserProfileData["specialty"]["scores"]) || {},
    },

    activity_level:
      (raw.activity_level as UserProfileData["activity_level"]) || "inactive",
    consistency_score: raw.consistency_score as number | undefined,

    connected_sources: raw.connected_sources as
      | Record<string, boolean>
      | undefined,

    last_updated: (raw.last_updated as string) || new Date().toISOString(),
    cache_valid_until:
      (raw.cache_valid_until as string) || new Date().toISOString(),
  };
}

/**
 * Get public profile for another user (hosted-service display).
 */
export async function getPublicProfile(
  userId: string
): Promise<UserProfileData> {
  const response = await getHostedServiceApi<ProfileRawData>(
    `/user-profile/${userId}`
  );

  if (!response || response.status === 1) {
    const errorMsg =
      (response?.data as { message?: string })?.message ||
      "Failed to fetch profile";
    throw new Error(errorMsg);
  }

  if (!response.data) {
    throw new Error("Profile not found");
  }

  return normalizeProfileData(response.data);
}

function normalizeFullProfileData(data: unknown): FullProfileData {
  const base = normalizeProfileData(data);
  const raw = data as Record<string, unknown>;

  return {
    ...base,
    date_of_birth: raw.date_of_birth as string | undefined,
    gender: raw.gender as string | undefined,
    bio: raw.bio as string | undefined,
    role: raw.role as string | undefined,
    location: raw.location as string | undefined,
    timezone: raw.timezone as string | undefined,
    skills: (raw.skills as string[]) || [],
    experience: (raw.experience as ExperienceItem[]) || [],
    education: (raw.education as EducationItem[]) || [],
    social_links: (raw.social_links as Record<string, string>) || {},
    is_public: (raw.is_public as boolean) ?? true,
  };
}

export async function getMyProfile(): Promise<FullProfileData> {
  const response =
    await getHostedServiceApi<ProfileRawData>("/user-profile/me");

  if (!response || response.status === 1) {
    const errorMsg =
      (response?.data as { message?: string })?.message ||
      "Failed to fetch profile";
    throw new Error(errorMsg);
  }

  if (!response.data) {
    throw new Error("Profile not found");
  }

  return normalizeFullProfileData(response.data);
}

export async function updateMyProfile(
  data: ProfileUpdateRequest
): Promise<FullProfileData> {
  const response = await putHostedServiceApi<ProfileRawData>(
    "/user-profile/me",
    data,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );

  if (!response || response.status === 1) {
    const errorMsg =
      (response?.data as { message?: string })?.message ||
      "Failed to update profile";
    throw new Error(errorMsg);
  }

  if (!response.data) {
    throw new Error("Profile update failed");
  }

  return normalizeFullProfileData(response.data);
}
