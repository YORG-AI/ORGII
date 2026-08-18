/**
 * Versioned, non-sensitive acknowledgement for the ORG2 Cloud introduction.
 *
 * This value deliberately contains no identity, endpoint, intent, or token
 * data. Bump the version only when a materially new introduction must be
 * shown once to people who acknowledged an older version.
 */
export const ORG2_CLOUD_ONBOARDING_VERSION = 1;

export const ORG2_CLOUD_ONBOARDING_STORAGE_KEY =
  "orgii:org2-cloud-v1:onboarding-version";

export function isOrg2CloudOnboardingAcknowledged(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ORG2_CLOUD_ONBOARDING_VERSION
  );
}
