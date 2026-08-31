/**
 * Inbox Converters
 *
 * Pure functions that convert git data into InboxMessage objects.
 * Also contains seed data for first-run inbox population.
 */
import type { GitCommitInfo } from "@src/api/http/git/types";
import type { GitOperation } from "@src/store/git/gitOperationAtom";

import type { InboxMessage, MessagePriority } from "../types";

// ============================================
// Git Operation → InboxMessage
// ============================================

const GIT_OP_PRIORITY: Record<string, MessagePriority> = {
  conflict: "urgent",
  merge: "high",
  rebase: "high",
  push: "medium",
  pull: "medium",
  commit: "low",
  fetch: "none",
  checkout: "none",
};

export function gitOperationToInboxMessage(
  operation: GitOperation
): InboxMessage {
  const priority = GIT_OP_PRIORITY[operation.operation] ?? "low";
  const content = operation.details || operation.summary;
  return {
    id: `git-op-${operation.id}`,
    title: operation.summary,
    preview: content,
    content,
    category: "git",
    priority,
    status: "unread",
    createdAt: new Date(operation.timestamp).toISOString(),
    updatedAt: new Date(operation.timestamp).toISOString(),
    sender: { name: "Git" },
    metadata: { repoName: operation.repoId },
  };
}

// ============================================
// Git Commit → InboxMessage
// ============================================

export const MAX_RECENT_COMMITS = 15;

export function gitCommitToInboxMessage(
  commit: GitCommitInfo,
  repoName?: string
): InboxMessage {
  return {
    id: `git-commit-${commit.sha}`,
    title: commit.summary,
    preview: commit.body?.trim() || commit.summary,
    content: [
      commit.summary,
      commit.body?.trim() ? `\n${commit.body.trim()}` : "",
      `\nCommit: ${commit.short_sha}`,
      `Author: ${commit.author.name} <${commit.author.email}>`,
      `Date: ${new Date(commit.author.date).toLocaleString()}`,
      commit.parent_shas.length > 1
        ? `Merge: ${commit.parent_shas.map((sha) => sha.slice(0, 7)).join(" ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    category: "git",
    priority: "low",
    status: "unread",
    createdAt: new Date(commit.author.date).toISOString(),
    updatedAt: new Date(commit.committer.date).toISOString(),
    sender: { name: commit.author.name },
    metadata: {
      repoName,
      commitHash: commit.short_sha,
    },
  };
}

// ============================================
// Seed data — upserted to DB on first load
// ============================================

export const SEED_MESSAGES: InboxMessage[] = [
  {
    id: "promo-1",
    title: "50% Off Premium Features",
    preview: "Upgrade your workspace with our limited time offer...",
    content: `We're excited to offer you an exclusive 50% discount on all Premium features!\n\nThis limited-time offer includes:\n- Unlimited AI sessions\n- Priority support\n- Advanced analytics\n- Team collaboration tools\n\nDon't miss out on this opportunity to supercharge your development workflow. Offer expires in 7 days.`,
    category: "promotion",
    priority: "medium",
    status: "unread",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    sender: { name: "Market" },
    metadata: {
      promotionType: "discount",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actionUrl: "/market/premium",
    },
    labels: [{ id: "offer", name: "Limited Offer", color: "#f59e0b" }],
  },
  {
    id: "promo-2",
    title: "New Extension: AI Code Review",
    preview: "Check out the latest AI-powered code review extension...",
    content: `Introducing AI Code Review — the newest addition to our market!\n\nFeatures:\n- Automated code quality analysis\n- Security vulnerability detection\n- Performance optimization suggestions\n- Integration with your existing workflow\n\nInstall now and get a 30-day free trial.`,
    category: "promotion",
    priority: "low",
    status: "read",
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    sender: { name: "Market" },
    metadata: {
      promotionType: "new_extension",
      actionUrl: "/market/extensions/ai-code-review",
    },
    labels: [{ id: "new", name: "New", color: "#10b981" }],
  },
  {
    id: "wi-1",
    title: "New Work Item Assigned",
    preview: "Fix login page responsive layout has been assigned to you...",
    content: `You have been assigned a new work item:\n\n**Fix login page responsive layout**\n\nPriority: High\nProject: Frontend App\nDue: Next Friday\n\nThe login page breaks on mobile devices below 375px width. The form fields overlap and the submit button is not visible.`,
    category: "workitems",
    priority: "high",
    status: "unread",
    createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    sender: { name: "Project Manager" },
    metadata: { projectName: "Frontend App", workItemId: "WI-142" },
    labels: [{ id: "assigned", name: "Assigned", color: "#3b82f6" }],
  },
  {
    id: "wi-2",
    title: "Work Item Status Changed",
    preview: "API Integration moved to 'In Progress'...",
    content: `Work item status update:\n\n**API Integration** has been moved from "To Do" to "In Progress".\n\nProject: Backend API\nAssigned to: Jane Smith`,
    category: "workitems",
    priority: "low",
    status: "unread",
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    sender: { name: "Project Manager" },
    metadata: { projectName: "Backend API", workItemId: "WI-98" },
    labels: [{ id: "status-change", name: "Status Change", color: "#8b5cf6" }],
  },
  {
    id: "wi-3",
    title: "Milestone Progress: Testing 80%",
    preview: "Testing project has reached 80% completion...",
    content: `Milestone update:\n\n**Testing** project has reached 80% completion.\n\n- 24 of 30 work items completed\n- 4 in progress\n- 2 remaining\n\nGreat progress! Keep it up.`,
    category: "workitems",
    priority: "low",
    status: "read",
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    sender: { name: "Project Manager" },
    metadata: { projectName: "Testing" },
    labels: [{ id: "milestone", name: "Milestone", color: "#10b981" }],
  },
];
