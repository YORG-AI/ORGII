/**
 * Conventional Commits enforcement for ORGII.
 *
 * Subjects must look like:
 *   <type>(<scope>?)!?: <description>
 *
 * Allowed types and scope conventions are documented in .github/CONTRIBUTING.md.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  ignores: [
    (message) => /^Merge (branch|pull request|remote-tracking branch|origin)/i.test(message),
  ],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "chore",
        "refactor",
        "docs",
        "style",
        "test",
        "perf",
        "build",
        "ci",
        "revert",
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "scope-case": [2, "always", "lower-case"],
    "subject-case": [0],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
    "body-leading-blank": [2, "always"],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
