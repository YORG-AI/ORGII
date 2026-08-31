//! Pull request commands: create/find/list, per-PR detail (commits, files),
//! reviews, inline review comments, and CI checks.
//!
//! This façade preserves the command and type paths while private modules own
//! pagination, listing, detail enrichment, merge automation, reviewers,
//! reviews/comments, and check-status rollup.

mod checks;
mod detail;
mod list_search;
mod merge;
mod pagination;
mod reviewers;
mod reviews;

pub use checks::{github_get_checks, GitHubCheckRun, GitHubChecksSummary, GitHubStatusContext};
pub use detail::{github_get_pr, github_list_pr_commits, github_list_pr_files};
pub use list_search::{
    github_create_pr, github_find_pull_request, github_list_prs, github_update_pr_state,
    CreatePRRequest, FindPRResponse, OpenPRItem, PRResponse, PullRequestCiStatus,
};
pub use merge::{
    github_merge_pr, github_set_pr_auto_merge, github_update_pr_draft_state,
    PullRequestAutoMergeResult, PullRequestMergeResult,
};
pub use reviewers::{github_remove_pr_reviewers, github_request_pr_reviewers};
pub use reviews::{
    github_create_pr_review, github_create_pr_review_comment, github_list_pr_review_comments,
    github_list_pr_reviews, github_reply_pr_review_comment, GitHubPrReview, GitHubReviewComment,
};

// `tauri::generate_handler!` resolves each generated `__cmd__*` item beside
// the public command path. Keep those hidden command shims on the stable
// `github::commands::*` surface as the leaf modules move behind this façade.
pub use checks::__cmd__github_get_checks;
pub use detail::{
    __cmd__github_get_pr, __cmd__github_list_pr_commits, __cmd__github_list_pr_files,
};
pub use list_search::{
    __cmd__github_create_pr, __cmd__github_find_pull_request, __cmd__github_list_prs,
    __cmd__github_update_pr_state,
};
pub use merge::{
    __cmd__github_merge_pr, __cmd__github_set_pr_auto_merge, __cmd__github_update_pr_draft_state,
};
pub use reviewers::{__cmd__github_remove_pr_reviewers, __cmd__github_request_pr_reviewers};
pub use reviews::{
    __cmd__github_create_pr_review, __cmd__github_create_pr_review_comment,
    __cmd__github_list_pr_review_comments, __cmd__github_list_pr_reviews,
    __cmd__github_reply_pr_review_comment,
};

#[cfg(test)]
pub(crate) use checks::{parse_check_run, parse_status_context, roll_up_checks_state};
#[cfg(test)]
pub(crate) use reviews::parse_review_comment;
