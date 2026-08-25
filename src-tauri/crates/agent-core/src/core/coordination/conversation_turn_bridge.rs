//! Hand-off for Work Item Run turns whose target Session lives on another
//! member's machine.
//!
//! A Discussion comment on a cloud-synced Work Item routes to the Work
//! Item's latest linked Session by id. When that Session is not local, the
//! durable dispatcher cannot resume it; instead the turn is offered to the
//! frontend, which executes it through the conversation-events plane (an
//! invisible local runner whose events are published under the root
//! Session id, design: docs/conversation-events-plane-design-2026-08-21.md).
//!
//! Acceptance is only an in-process claim: it never marks the durable outbox
//! delivered. The accepted frontend first prepares the real local runner,
//! sends the exact turn intent, then explicitly acknowledges that runner.
//! Only a successful durable ack consumes the claim; a crash before ack or a
//! transient ack failure therefore leaves the lease reclaimable/retryable.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::oneshot;
use tracing::warn;

pub const CONVERSATION_TURN_REQUESTED_EVENT: &str = "orgii-work-run-conversation-turn";
// The frontend's cold capability probe is bounded at 15 seconds. Leave room
// for token refresh and local org-alias lookup so a capable cold window can
// still claim before this offer is retried.
pub const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);
const CLAIM_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const CLAIM_LEASE_EXTENSION_MS: i64 = 45_000;
// An offer must be accepted inside ACCEPT_TIMEOUT, before the frontend can
// wait for the canonical per-conversation queue. Cover one maximum 15-minute
// turn ahead of this claim, the 2-minute setup bound, and prepare/send/ack
// cushion. Keep it finite so a vanished webview cannot retain a durable
// dispatch forever (process death stops the task immediately).
const CLAIM_HEARTBEAT_MAX_LIFETIME: Duration = Duration::from_secs(20 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurnRequest {
    pub run_id: String,
    pub dispatch_id: String,
    pub org_id: String,
    pub project_slug: Option<String>,
    pub work_item_id: String,
    pub work_item_title: Option<String>,
    pub assigned_agent_id: Option<String>,
    pub root_session_id: String,
    pub prepared_runner_session_id: Option<String>,
    pub content: String,
    pub display_text: Option<String>,
    pub discussion_comment_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationTurnOffer {
    #[serde(flatten)]
    request: ConversationTurnRequest,
    claim_token: String,
}

type AcceptSender = oneshot::Sender<Result<(), String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationTurnClaim {
    pub run_id: String,
    pub dispatch_id: String,
    pub lease_token: String,
    pub claim_token: String,
    pub root_session_id: String,
}

struct PendingOffer {
    claim: ConversationTurnClaim,
    accept_sender: Option<AcceptSender>,
    claimed: bool,
    runner_session_id: Option<String>,
}

static PENDING: OnceLock<Mutex<HashMap<String, PendingOffer>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, PendingOffer>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register(claim: ConversationTurnClaim) -> oneshot::Receiver<Result<(), String>> {
    let (tx, rx) = oneshot::channel();
    let mut map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.insert(
        claim.run_id.clone(),
        PendingOffer {
            claim,
            accept_sender: Some(tx),
            claimed: false,
            runner_session_id: None,
        },
    );
    rx
}

fn unregister(run_id: &str, lease_token: &str, claim_token: &str) {
    let mut map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if map.get(run_id).is_some_and(|offer| {
        offer.claim.lease_token == lease_token && offer.claim.claim_token == claim_token
    }) {
        map.remove(run_id);
    }
}

/// Claim or abstain from the current offer. A successful claim only elects
/// one frontend listener; the outbox remains leased until `prepared_claim`
/// supplies the exact prepared local runner Session to the explicit ack.
/// Negative listeners deliberately do not resolve the shared offer: every
/// app window receives it, and an incapable window must not preempt a capable
/// winner. If nobody can claim, the request's bounded timeout drives retry.
pub fn accept(run_id: &str, claim_token: &str, outcome: Result<(), String>) -> Option<String> {
    let (sender, accepted_claim) = {
        let mut map = pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match outcome {
            Ok(()) => {
                let offer = map.get_mut(run_id)?;
                if offer.claim.claim_token != claim_token || offer.claimed {
                    return None;
                }
                offer.claimed = true;
                (offer.accept_sender.take(), offer.claim.clone())
            }
            Err(_) => return None,
        }
    };
    let sender = sender?;
    if sender.send(Ok(())).is_ok() {
        let accepted_claim_token = accepted_claim.claim_token.clone();
        start_claim_heartbeat(accepted_claim);
        Some(accepted_claim_token)
    } else {
        unregister(run_id, &accepted_claim.lease_token, claim_token);
        None
    }
}

fn claim_is_current(claim: &ConversationTurnClaim) -> bool {
    let map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.get(&claim.run_id).is_some_and(|offer| {
        offer.claimed
            && offer.claim.lease_token == claim.lease_token
            && offer.claim.claim_token == claim.claim_token
    })
}

fn start_claim_heartbeat(claim: ConversationTurnClaim) {
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + CLAIM_HEARTBEAT_MAX_LIFETIME;
        loop {
            tokio::time::sleep(CLAIM_HEARTBEAT_INTERVAL).await;
            if !claim_is_current(&claim) {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                // Stop both renewal and in-process authority. A frontend that
                // resumes after this bound must lose prepare/ack to the next
                // fenced re-offer instead of sending under an expired claim.
                unregister(&claim.run_id, &claim.lease_token, &claim.claim_token);
                break;
            }
            let dispatch_id = claim.dispatch_id.clone();
            let lease_token = claim.lease_token.clone();
            let renewed = tokio::task::spawn_blocking(move || {
                project_management::work_run_service::renew_dispatch_lease(
                    &dispatch_id,
                    &lease_token,
                    CLAIM_LEASE_EXTENSION_MS,
                )
            })
            .await;
            match renewed {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => {
                    unregister(&claim.run_id, &claim.lease_token, &claim.claim_token);
                    break;
                }
                Ok(Err(error)) => warn!(
                    run_id = %claim.run_id,
                    error = %error,
                    "[conversation-turn-bridge] claim heartbeat failed"
                ),
                Err(error) => warn!(
                    run_id = %claim.run_id,
                    error = %error,
                    "[conversation-turn-bridge] claim heartbeat task failed"
                ),
            }
        }
    });
}

/// Record the real local runner selected by the winning frontend without
/// acknowledging the durable outbox. Repeating prepare for the same runner
/// is idempotent; changing runners under one claim is rejected.
pub fn prepare_bound_claim(
    run_id: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> Result<(), String> {
    let mut map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(offer) = map.get_mut(run_id) else {
        return Err(format!(
            "conversation turn claim is not pending for run {run_id}"
        ));
    };
    if !offer.claimed {
        return Err(format!(
            "conversation turn offer has not been claimed for run {run_id}"
        ));
    }
    if offer.claim.claim_token != claim_token {
        return Err(format!(
            "conversation turn claim token mismatch for run {run_id}"
        ));
    }
    if offer.claim.root_session_id != root_session_id {
        return Err(format!(
            "conversation turn root mismatch for run {run_id}: expected {}, got {root_session_id}",
            offer.claim.root_session_id
        ));
    }
    if let Some(prepared) = offer.runner_session_id.as_deref() {
        if prepared == runner_session_id {
            return Ok(());
        }
        return Err(format!(
            "conversation turn runner mismatch for run {run_id}: prepared {prepared}, got {runner_session_id}"
        ));
    }
    offer.runner_session_id = Some(runner_session_id.to_string());
    Ok(())
}

/// Snapshot a prepared claim only when the ack names the exact root and runner
/// selected during prepare. The caller must not consume it until the durable
/// outbox acknowledgement commits.
pub fn prepared_claim(
    run_id: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> Result<ConversationTurnClaim, String> {
    let map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(offer) = map.get(run_id) else {
        return Err(format!(
            "conversation turn claim is not pending for run {run_id}"
        ));
    };
    if !offer.claimed {
        return Err(format!(
            "conversation turn offer has not been claimed for run {run_id}"
        ));
    }
    if offer.claim.claim_token != claim_token {
        return Err(format!(
            "conversation turn claim token mismatch for run {run_id}"
        ));
    }
    if offer.claim.root_session_id != root_session_id {
        return Err(format!(
            "conversation turn root mismatch for run {run_id}: expected {}, got {root_session_id}",
            offer.claim.root_session_id
        ));
    }
    let Some(prepared_runner) = offer.runner_session_id.as_deref() else {
        return Err(format!(
            "conversation turn runner is not prepared for run {run_id}"
        ));
    };
    if prepared_runner != runner_session_id {
        return Err(format!(
            "conversation turn runner mismatch for run {run_id}: prepared {prepared_runner}, got {runner_session_id}"
        ));
    }
    Ok(offer.claim.clone())
}

/// Consume a prepared claim after durable acknowledgement, but only if the
/// same lease/root/runner is still current. A late completion from an expired
/// claimant must never remove a newer re-offer.
pub fn consume_prepared_claim(
    run_id: &str,
    lease_token: &str,
    claim_token: &str,
    root_session_id: &str,
    runner_session_id: &str,
) -> bool {
    let mut map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let matches = map.get(run_id).is_some_and(|offer| {
        offer.claimed
            && offer.claim.lease_token == lease_token
            && offer.claim.claim_token == claim_token
            && offer.claim.root_session_id == root_session_id
            && offer.runner_session_id.as_deref() == Some(runner_session_id)
    });
    if matches {
        map.remove(run_id);
    }
    matches
}

/// Drop one accepted frontend claim without touching a newer re-offer. The
/// caller uses the returned durable lease identity to shorten the outbox lease;
/// if ack already consumed the claim this is an idempotent no-op.
pub fn release_claim(run_id: &str, claim_token: &str) -> Option<ConversationTurnClaim> {
    let mut map = pending()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let matches = map
        .get(run_id)
        .is_some_and(|offer| offer.claimed && offer.claim.claim_token == claim_token);
    if !matches {
        return None;
    }
    map.remove(run_id).map(|offer| offer.claim)
}

/// Phrased so `work_run_service::classify_failure` files it as a retryable
/// timeout that resumes the same target: the next attempt finds the
/// frontend once it is listening.
pub fn accept_timeout_message(run_id: &str) -> String {
    format!(
        "conversation turn hand-off timed out: no frontend accepted run {run_id} within {}s",
        ACCEPT_TIMEOUT.as_secs()
    )
}

pub fn rejection_message(reason: &str) -> String {
    format!("conversation turn hand-off rejected: {reason}")
}

/// Offer the turn to the frontend and wait for its acceptance.
pub async fn request_conversation_turn(
    app: &tauri::AppHandle,
    request: ConversationTurnRequest,
    lease_token: String,
) -> Result<(), String> {
    let run_id = request.run_id.clone();
    let claim_token = format!("claim_{}", uuid::Uuid::new_v4().simple());
    let claim = ConversationTurnClaim {
        run_id: run_id.clone(),
        dispatch_id: request.dispatch_id.clone(),
        lease_token: lease_token.clone(),
        claim_token: claim_token.clone(),
        root_session_id: request.root_session_id.clone(),
    };
    let receiver = register(claim);
    let offer = ConversationTurnOffer {
        request,
        claim_token: claim_token.clone(),
    };
    if let Err(err) = app.emit(CONVERSATION_TURN_REQUESTED_EVENT, offer) {
        unregister(&run_id, &lease_token, &claim_token);
        return Err(format!("conversation turn hand-off emit failed: {err}"));
    }
    match tokio::time::timeout(ACCEPT_TIMEOUT, receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(reason))) => Err(rejection_message(&reason)),
        Ok(Err(_)) => {
            unregister(&run_id, &lease_token, &claim_token);
            Err("conversation turn hand-off was dropped before acceptance".to_string())
        }
        Err(_) => {
            unregister(&run_id, &lease_token, &claim_token);
            warn!(run_id, "[conversation-turn-bridge] acceptance timed out");
            Err(accept_timeout_message(&run_id))
        }
    }
}

#[cfg(test)]
mod tests {
    use project_management::projects::types::{
        WorkItemRunFailureClass, WorkItemRunRetryDisposition,
    };
    use project_management::work_run_service::classify_failure;

    use super::*;

    #[test]
    fn acceptance_timeout_is_a_retryable_resume() {
        let failure = classify_failure(&accept_timeout_message("run-1"), true);
        assert_eq!(failure.class, WorkItemRunFailureClass::Timeout);
        assert!(failure.retryable);
        assert_eq!(
            failure.retry_disposition,
            WorkItemRunRetryDisposition::ResumeSession
        );
    }

    #[test]
    fn rejection_is_filed_for_manual_review() {
        let failure = classify_failure(&rejection_message("cloud sign-in required"), true);
        assert_eq!(failure.class, WorkItemRunFailureClass::Unknown);
        assert!(!failure.retryable);
    }

    #[test]
    fn heartbeat_horizon_covers_a_queued_turn_setup_and_transport_ack() {
        const MAX_QUEUED_TURN: Duration = Duration::from_secs(15 * 60);
        const MAX_BACKGROUND_SETUP: Duration = Duration::from_secs(2 * 60);
        const ACK_CUSHION: Duration = Duration::from_secs(2 * 60);

        assert!(
            CLAIM_HEARTBEAT_MAX_LIFETIME >= MAX_QUEUED_TURN + MAX_BACKGROUND_SETUP + ACK_CUSHION
        );
        assert!(
            Duration::from_millis(CLAIM_LEASE_EXTENSION_MS as u64) > CLAIM_HEARTBEAT_INTERVAL * 2,
            "each renewal must survive more than one missed heartbeat"
        );
    }

    #[test]
    fn acceptance_window_covers_the_cold_capability_probe() {
        const FRONTEND_CAPABILITY_TIMEOUT: Duration = Duration::from_secs(15);
        assert!(ACCEPT_TIMEOUT > FRONTEND_CAPABILITY_TIMEOUT);
    }

    #[tokio::test]
    async fn failed_ack_keeps_prepared_claim_and_successful_ack_consumes_it() {
        let receiver = register(ConversationTurnClaim {
            run_id: "run-resolve".into(),
            dispatch_id: "dispatch-1".into(),
            lease_token: "lease-1".into(),
            claim_token: "claim-1".into(),
            root_session_id: "root-1".into(),
        });
        assert_eq!(
            accept("run-resolve", "claim-1", Ok(())),
            Some("claim-1".to_string())
        );
        assert_eq!(receiver.await.expect("resolved"), Ok(()));
        assert_eq!(accept("run-resolve", "claim-1", Ok(())), None);

        prepare_bound_claim("run-resolve", "claim-1", "root-1", "runner-1")
            .expect("prepare runner");
        prepare_bound_claim("run-resolve", "claim-1", "root-1", "runner-1")
            .expect("same prepare is idempotent");
        assert!(prepared_claim("run-resolve", "claim-1", "root-1", "runner-other").is_err());
        let claim = prepared_claim("run-resolve", "claim-1", "root-1", "runner-1")
            .expect("first durable ack attempt snapshots the claim");
        assert_eq!(claim.dispatch_id, "dispatch-1");
        assert_eq!(claim.lease_token, "lease-1");

        // Simulate a transient durable-store failure: no consume occurs, so
        // the exact same prepared ack can be retried.
        let retry = prepared_claim("run-resolve", "claim-1", "root-1", "runner-1")
            .expect("failed durable ack remains retryable");
        assert_eq!(retry, claim);
        assert!(consume_prepared_claim(
            "run-resolve",
            &claim.lease_token,
            "claim-1",
            "root-1",
            "runner-1"
        ));
        assert!(!claim_is_current(&claim));
        assert!(prepared_claim("run-resolve", "claim-1", "root-1", "runner-1").is_err());
        assert!(release_claim("run-resolve", "claim-1").is_none());
    }

    #[tokio::test]
    async fn a_reoffer_replaces_the_expired_lease_without_stale_cleanup() {
        let first = register(ConversationTurnClaim {
            run_id: "run-reoffer".into(),
            dispatch_id: "dispatch-1".into(),
            lease_token: "lease-old".into(),
            claim_token: "claim-old".into(),
            root_session_id: "root-1".into(),
        });
        assert_eq!(
            accept("run-reoffer", "claim-old", Ok(())),
            Some("claim-old".to_string())
        );
        assert_eq!(first.await.expect("first accepted"), Ok(()));

        let second = register(ConversationTurnClaim {
            run_id: "run-reoffer".into(),
            dispatch_id: "dispatch-1".into(),
            lease_token: "lease-new".into(),
            claim_token: "claim-new".into(),
            root_session_id: "root-1".into(),
        });
        unregister("run-reoffer", "lease-old", "claim-old");
        assert_eq!(accept("run-reoffer", "claim-old", Ok(())), None);
        assert_eq!(
            accept("run-reoffer", "claim-new", Ok(())),
            Some("claim-new".to_string())
        );
        assert_eq!(second.await.expect("second accepted"), Ok(()));
        assert!(prepare_bound_claim("run-reoffer", "claim-old", "root-1", "runner-2").is_err());
        prepare_bound_claim("run-reoffer", "claim-new", "root-1", "runner-2").expect("prepare new");
        let claim =
            prepared_claim("run-reoffer", "claim-new", "root-1", "runner-2").expect("new claim");
        assert_eq!(claim.lease_token, "lease-new");
        assert!(!consume_prepared_claim(
            "run-reoffer",
            "lease-old",
            "claim-old",
            "root-1",
            "runner-2"
        ));
        assert!(prepared_claim("run-reoffer", "claim-new", "root-1", "runner-2").is_ok());
    }

    #[tokio::test]
    async fn a_losing_rejection_cannot_clear_the_winning_claim() {
        let receiver = register(ConversationTurnClaim {
            run_id: "run-reject-race".into(),
            dispatch_id: "dispatch-1".into(),
            lease_token: "lease-1".into(),
            claim_token: "claim-race".into(),
            root_session_id: "root-1".into(),
        });
        assert_eq!(
            accept("run-reject-race", "claim-race", Ok(())),
            Some("claim-race".to_string())
        );
        assert_eq!(receiver.await.expect("accepted"), Ok(()));
        assert_eq!(
            accept(
                "run-reject-race",
                "claim-race",
                Err("signed out in another window".into())
            ),
            None
        );
        prepare_bound_claim("run-reject-race", "claim-race", "root-1", "runner-1")
            .expect("prepare");
        assert!(prepared_claim("run-reject-race", "claim-race", "root-1", "runner-1").is_ok());
    }

    #[tokio::test]
    async fn an_incapable_listener_cannot_preempt_a_capable_listener() {
        let receiver = register(ConversationTurnClaim {
            run_id: "run-multi-window".into(),
            dispatch_id: "dispatch-multi-window".into(),
            lease_token: "lease-multi-window".into(),
            claim_token: "claim-multi-window".into(),
            root_session_id: "root-multi-window".into(),
        });

        assert_eq!(
            accept(
                "run-multi-window",
                "claim-multi-window",
                Err("cloud sign-in required".into())
            ),
            None
        );
        assert_eq!(
            accept("run-multi-window", "claim-multi-window", Ok(())),
            Some("claim-multi-window".to_string())
        );
        assert_eq!(receiver.await.expect("capable listener accepted"), Ok(()));
    }

    #[tokio::test]
    async fn release_is_claim_token_fenced_and_stops_pre_send_authority() {
        let receiver = register(ConversationTurnClaim {
            run_id: "run-release".into(),
            dispatch_id: "dispatch-release".into(),
            lease_token: "lease-release".into(),
            claim_token: "claim-release".into(),
            root_session_id: "root-release".into(),
        });
        assert_eq!(
            accept("run-release", "claim-release", Ok(())),
            Some("claim-release".to_string())
        );
        assert_eq!(receiver.await.expect("accepted"), Ok(()));

        assert!(release_claim("run-release", "claim-stale").is_none());
        let current = release_claim("run-release", "claim-release").expect("release exact claim");
        assert_eq!(current.lease_token, "lease-release");
        assert!(!claim_is_current(&current));
        assert!(prepare_bound_claim(
            "run-release",
            "claim-release",
            "root-release",
            "runner-release"
        )
        .is_err());
        assert!(release_claim("run-release", "claim-release").is_none());
    }

    #[test]
    fn request_payload_uses_camel_case_wire_names() {
        let value = serde_json::to_value(ConversationTurnOffer {
            claim_token: "claim-wire".into(),
            request: ConversationTurnRequest {
                run_id: "run".into(),
                dispatch_id: "dispatch".into(),
                org_id: "org".into(),
                project_slug: Some("proj".into()),
                work_item_id: "WI-1".into(),
                work_item_title: None,
                assigned_agent_id: Some("agent-a".into()),
                root_session_id: "root".into(),
                prepared_runner_session_id: Some("runner".into()),
                content: "body".into(),
                display_text: Some("💬 body".into()),
                discussion_comment_ids: vec!["c1".into()],
            },
        })
        .expect("serialize");
        assert_eq!(value["runId"], "run");
        assert_eq!(value["assignedAgentId"], "agent-a");
        assert_eq!(value["rootSessionId"], "root");
        assert_eq!(value["preparedRunnerSessionId"], "runner");
        assert_eq!(value["claimToken"], "claim-wire");
        assert_eq!(value["discussionCommentIds"][0], "c1");
    }
}
