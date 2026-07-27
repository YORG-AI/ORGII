import { invoke } from "@tauri-apps/api/core";

export type GitHubStarUnavailableReason =
  | "gh_missing"
  | "not_authenticated"
  | "network"
  | "permission"
  | "timeout"
  | "unexpected";

export type GitHubStarResult =
  | { status: "starred" }
  | { status: "not_starred" }
  | { status: "unavailable"; reason: GitHubStarUnavailableReason };

let checkPromise: Promise<GitHubStarResult> | null = null;
let starPromise: Promise<GitHubStarResult> | null = null;

function singleFlight(
  current: Promise<GitHubStarResult> | null,
  command: "check_orgii_star" | "star_orgii",
  clear: (promise: Promise<GitHubStarResult>) => void
): Promise<GitHubStarResult> {
  if (current) return current;

  const promise = invoke<GitHubStarResult>(command);
  clear(promise);
  return promise;
}

export function checkOrgiiStar(): Promise<GitHubStarResult> {
  return singleFlight(checkPromise, "check_orgii_star", (promise) => {
    checkPromise = promise;
    void promise.then(
      () => {
        if (checkPromise === promise) checkPromise = null;
      },
      () => {
        if (checkPromise === promise) checkPromise = null;
      }
    );
  });
}

export function starOrgii(): Promise<GitHubStarResult> {
  return singleFlight(starPromise, "star_orgii", (promise) => {
    starPromise = promise;
    void promise.then(
      () => {
        if (starPromise === promise) starPromise = null;
      },
      () => {
        if (starPromise === promise) starPromise = null;
      }
    );
  });
}
