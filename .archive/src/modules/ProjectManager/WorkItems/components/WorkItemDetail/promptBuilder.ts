import type { ReviewFeedback } from "@src/api/http/project";
import type { AgentExecMode } from "@src/features/SessionCreator/config";
import type {
  TodoItem,
  WorkItem as WorkItemExtended,
} from "@src/types/core/workItem";

function formatAgentExecModeSection(mode: AgentExecMode): string {
  const guidance: Record<AgentExecMode, string> = {
    build:
      "Deliver a full implementation: code, tests, and commits as needed to satisfy the work item.",
    ask: "Research the codebase and answer the user's questions; summarize findings with specific file paths, line numbers, and code snippets. Do not edit files or run destructive commands unless the user explicitly asks for implementation.",
    plan: "Draft a concrete implementation plan (context, step-by-step changes, key files, risks) and write it to the plan file via `create_plan`. Do not edit any other files.",
    debug:
      "Focus on diagnosis, root cause, and minimal targeted fixes; verify with tests and narrow regressions.",
    review:
      "Review code and requirements; produce a structured verdict without implementing changes unless explicitly asked.",
    wingman:
      "Observe the user silently. Watch periodic screenshots and recent activity; only speak up when you spot something that genuinely matters. Do not edit files or run destructive commands.",
  };
  return `\n## Agent mode (${mode})\n${guidance[mode]}`;
}

function formatTodos(todos?: TodoItem[]): string {
  if (!todos?.length) return "";
  const lines = todos.map((todo) => {
    const check = todo.status === "completed" ? "[x]" : "[ ]";
    return `  ${check} ${todo.content}`;
  });
  return `\n## Acceptance Criteria / Todos\n${lines.join("\n")}`;
}

function formatPreviousReviewFeedback(
  reviewFeedback?: ReviewFeedback,
  reviewHistory?: ReviewFeedback[]
): string {
  const latest = reviewFeedback;
  if (!latest || latest.outcome === "approved") return "";

  const parts: string[] = [];
  parts.push("\n## Previous Review Feedback (from the last review round)");
  parts.push(`Outcome: ${latest.outcome}`);
  parts.push(`Summary: ${latest.summary}`);

  if (latest.comments?.length) {
    parts.push("Issues found:");
    latest.comments.forEach((comment, idx) => {
      const loc = [comment.file_path, comment.line].filter(Boolean).join(":");
      const severity = comment.severity.toUpperCase();
      parts.push(
        `  ${idx + 1}. [${severity}] ${loc ? loc + " — " : ""}${comment.message}`
      );
    });
  }

  const round = (reviewHistory?.length ?? 0) + 1;
  parts.push(
    `\nThis is review round ${round}. Check if the above issues from the previous round have been addressed in the current diff.`
  );

  return parts.join("\n");
}

function formatReviewFeedbackForSde(
  reviewFeedback?: ReviewFeedback,
  reviewHistory?: ReviewFeedback[]
): string {
  const latest = reviewFeedback;
  if (!latest || latest.outcome === "approved") return "";

  const parts: string[] = [];
  parts.push("\n## Review Feedback To Address");
  parts.push(`Outcome: ${latest.outcome}`);
  parts.push(`Summary: ${latest.summary}`);

  const actionableComments = latest.comments?.filter(
    (comment) => comment.severity !== "praise"
  );

  if (actionableComments?.length) {
    parts.push("Address all of the following items before finishing:");
    actionableComments.forEach((comment, idx) => {
      const loc = [comment.file_path, comment.line].filter(Boolean).join(":");
      const severity = comment.severity.toUpperCase();
      parts.push(
        `  ${idx + 1}. [${severity}] ${loc ? loc + " — " : ""}${comment.message}`
      );
    });
  }

  const round = (reviewHistory?.length ?? 0) + 1;
  parts.push(
    `\nThis is implementation round ${round} after a review-requested rerun. Fix the issues above explicitly and verify they are resolved before you finish.`
  );

  return parts.join("\n");
}

export function buildSdeTaskPrompt(
  workItem: WorkItemExtended,
  shortId: string,
  additionalInstructions?: string,
  mode?: AgentExecMode
): string {
  const parts: string[] = [];
  const isPlan = mode === "plan";
  const isAsk = mode === "ask";
  const isReview = mode === "review";
  const isDebug = mode === "debug";
  const readOnlyMode = isPlan || isAsk || isReview;

  if (isPlan) {
    parts.push(
      `Create a detailed implementation plan for the following work item: ${shortId}`
    );
  } else if (isAsk) {
    parts.push(
      `Research the codebase and answer questions about the following work item: ${shortId}`
    );
  } else if (isReview) {
    parts.push(
      `Review the implementation against requirements for the following work item: ${shortId}`
    );
  } else if (isDebug) {
    parts.push(
      `Diagnose and fix issues for the following work item: ${shortId}`
    );
  } else {
    parts.push(`Implement the following work item: ${shortId}`);
  }

  parts.push(`\n## Title\n${workItem.name || "Untitled"}`);

  if (workItem.spec) {
    parts.push(`\n## Description\n${workItem.spec}`);
  }

  if (mode) {
    parts.push(formatAgentExecModeSection(mode));
  }

  parts.push(formatTodos(workItem.todos));

  if (!readOnlyMode) {
    parts.push(
      formatReviewFeedbackForSde(
        workItem.proofOfWork?.review_feedback,
        workItem.proofOfWork?.review_history
      )
    );
  }

  const trimmedInstructions = additionalInstructions?.trim();
  if (trimmedInstructions) {
    parts.push(`\n## Additional Instructions\n${trimmedInstructions}`);
  }

  if (isPlan) {
    parts.push(`
## Instructions
- Thoroughly research the codebase to understand the relevant architecture
- Produce a structured plan covering: context, step-by-step changes, key files, and risks
- Write the plan to the plan file with \`create_plan\`; once it finishes writing, the plan is automatically submitted for the user to review
- Do NOT edit any other files`);
  } else if (isAsk) {
    parts.push(`
## Instructions
- Search the codebase to find all relevant files, patterns, and dependencies
- Summarize findings with specific file paths, line numbers, and code snippets
- Answer the user's questions directly and cite evidence
- Do NOT edit files or run shell commands unless the user explicitly asks for implementation`);
  } else if (isReview) {
    parts.push(`
## Instructions
- Inspect the diff and linked requirements; cite specific files and lines
- Produce a clear verdict with actionable feedback where changes are needed
- Do NOT implement fixes unless the user explicitly requests implementation work`);
  } else if (isDebug) {
    parts.push(`
## Instructions
- Reproduce the issue, isolate the root cause, and apply minimal targeted fixes
- Add or update tests to prevent regressions
- Run tests and lint to verify your changes
- Commit your changes with clear messages referencing ${shortId}`);
  } else {
    parts.push(`
## Instructions
- Create a feature branch for this work item if one does not already exist
- Implement all changes needed to satisfy the description and acceptance criteria above
- If review feedback is provided above, address every actionable item before finishing
- Write or update tests where appropriate
- Run tests and lint to verify your changes
- Commit your changes with clear messages referencing ${shortId}`);
  }

  return parts.filter(Boolean).join("\n");
}

export function buildReviewTaskPrompt(
  workItem: WorkItemExtended,
  shortId: string,
  branchName?: string,
  baseBranch?: string
): string {
  const parts: string[] = [];

  parts.push(`Review the code changes for work item: ${shortId}`);

  parts.push(`\n## Work Item Title\n${workItem.name || "Untitled"}`);

  if (workItem.spec) {
    parts.push(`\n## Work Item Description\n${workItem.spec}`);
  }

  parts.push(formatTodos(workItem.todos));

  const effectiveBranch = branchName || workItem.proofOfWork?.branch;
  const effectiveBase = baseBranch || "main";
  parts.push(`\n## Branch Information`);
  if (effectiveBranch) {
    parts.push(`- Work item branch: \`${effectiveBranch}\``);
  }
  parts.push(`- Base branch: \`${effectiveBase}\``);
  parts.push(
    `- Run: \`git diff ${effectiveBase}..${effectiveBranch || "HEAD"}\` to see all changes`
  );

  const previousFeedback = formatPreviousReviewFeedback(
    workItem.proofOfWork?.review_feedback,
    workItem.proofOfWork?.review_history
  );
  if (previousFeedback) {
    parts.push(previousFeedback);
  }

  return parts.filter(Boolean).join("\n");
}
