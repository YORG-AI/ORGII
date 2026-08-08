import type { GitHubIssue, GitHubIssueUser } from "@src/api/tauri/github";

export function resolveGitHubAssigneeUsers(
  currentAssignees: GitHubIssueUser[],
  assignableUsers: GitHubIssueUser[],
  assigneeLogins: string[]
): GitHubIssueUser[] {
  const usersByLogin = new Map(
    [...currentAssignees, ...assignableUsers].map((user) => [
      user.login.toLowerCase(),
      user,
    ])
  );

  return assigneeLogins.map(
    (login) =>
      usersByLogin.get(login.toLowerCase()) ?? { login, avatar_url: "" }
  );
}

export function issueHasAssigneeLogins(
  issue: GitHubIssue,
  assigneeLogins: string[]
): boolean {
  const actual = issue.assignees
    .map((assignee) => assignee.login.toLowerCase())
    .sort();
  const expected = assigneeLogins.map((login) => login.toLowerCase()).sort();

  return (
    actual.length === expected.length &&
    actual.every((login, index) => login === expected[index])
  );
}
