#!/usr/bin/env node

const fs = require("node:fs");

const REQUIRED_FIRST_SECTIONS = Object.freeze([
  "Problem",
  "Solution",
  "Potential risks",
]);

const TITLE_PATTERN =
  /^(feat|fix|refactor|perf|test|docs|chore|build|ci|style|revert)\(([a-z0-9]+(?:-[a-z0-9]+)*)\): (\S.*)$/;

function parseTitle(title) {
  const match = TITLE_PATTERN.exec(title || "");
  if (!match) return null;

  const [, type, scope, summary] = match;
  return {
    type,
    scope,
    summary,
  };
}

function markdownSections(body) {
  const source = body || "";
  const matches = [...source.matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gm)];

  return matches.map((match, index) => ({
    title: match[1],
    content: source.slice(
      match.index + match[0].length,
      matches[index + 1]?.index ?? source.length
    ),
  }));
}

function hasMeaningfulContent(content) {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "").trim();
  return withoutComments.length > 0 && !/^[-_*`\s]+$/.test(withoutComments);
}

function validateDescription(body) {
  const sections = markdownSections(body);
  const errors = [];
  const firstTitles = sections.slice(0, 3).map(({ title }) => title);

  if (
    firstTitles.length !== REQUIRED_FIRST_SECTIONS.length ||
    firstTitles.some((title, index) => title !== REQUIRED_FIRST_SECTIONS[index])
  ) {
    errors.push(
      "The description must begin with ## Problem, ## Solution, and ## Potential risks in that exact order."
    );
  }

  for (const title of REQUIRED_FIRST_SECTIONS) {
    const section = sections.find((candidate) => candidate.title === title);
    if (!section || !hasMeaningfulContent(section.content)) {
      errors.push(`The ## ${title} section must contain meaningful content.`);
    }
  }

  const verification = sections.find(
    (section) => section.title === "Verification"
  );
  if (!verification || !hasMeaningfulContent(verification.content)) {
    errors.push("A non-empty ## Verification section is required.");
  }

  return errors;
}

function validatePullRequest({ title, body }) {
  const parsedTitle = parseTitle(title);
  const errors = [];

  if (!parsedTitle) {
    errors.push(
      "Title must use type(lowercase-kebab-scope): summary with an allowed Conventional Commit type."
    );
  }

  errors.push(...validateDescription(body));
  return errors;
}

function workflowError(message) {
  const escaped = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.error(`::error::${escaped}`);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  if (!event.pull_request) {
    throw new Error("The PR policy workflow requires a pull_request event.");
  }

  const errors = validatePullRequest({
    title: event.pull_request.title,
    body: event.pull_request.body || "",
  });

  if (errors.length > 0) {
    errors.forEach(workflowError);
    process.exitCode = 1;
    return;
  }

  console.log(
    `PR #${event.pull_request.number} satisfies the tracked PR contract.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    workflowError(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  markdownSections,
  parseTitle,
  validateDescription,
  validatePullRequest,
};
