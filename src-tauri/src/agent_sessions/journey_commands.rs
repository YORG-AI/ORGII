//! Desktop command adapter for the durable Session Journey application service.
//!
//! Commands in this module intentionally contain no lifecycle decisions and no
//! provider calls. They only marshal typed requests to the shared application
//! service on SQLite's blocking thread pool.

use agent_core::core::journey_lifecycle::RuntimeProvenance;
use agent_core::session::journey_application_service::{
    CreateCheckpointRequest, CreateForkRequest, CreateTaskRequest, DiscardForkRequest,
    DiscardForkResponse, FinishTaskRequest, ForkCompareResponse, JourneySnapshotResponse,
    JourneyWriteResponse, PromoteFactRequest, RequestForkCloseRequest, RetryReviewRequest,
    ReturnToParentRequest, ReturnToParentResponse, SessionJourneyApplicationService,
};
use agent_core::session::journey_review_queue::ReviewJob;

fn open_connection() -> Result<database::db::PooledConnection, String> {
    database::db::get_connection().map_err(|error| format!("无法打开会话旅程数据库：{error}"))
}

fn service_error(error: impl std::fmt::Display) -> String {
    format!("会话旅程操作失败：{error}")
}

#[tauri::command]
pub async fn journey_snapshot(session_id: String) -> Result<JourneySnapshotResponse, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_connection()?;
        SessionJourneyApplicationService::snapshot(&conn, &session_id).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程查询任务异常：{error}"))?
}

#[tauri::command]
pub async fn journey_task_start(
    request: CreateTaskRequest,
) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::create_task(&mut conn, request).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程任务启动异常：{error}"))?
}

#[tauri::command]
pub async fn journey_checkpoint(
    request: CreateCheckpointRequest,
) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::create_checkpoint(&mut conn, request)
            .map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程检查点异常：{error}"))?
}

#[tauri::command]
pub async fn journey_task_finish(
    request: FinishTaskRequest,
) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::finish_task(&mut conn, request).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程任务完成异常：{error}"))?
}

#[tauri::command]
pub async fn journey_fork_start(
    request: CreateForkRequest,
) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::create_fork(&mut conn, request).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程分叉启动异常：{error}"))?
}

/// Closes a fork and durably queues a provider-neutral review job. Desktop
/// resolves provenance from the durable session/key records so UI callers
/// cannot omit or forge the runtime identity.
#[tauri::command]
pub async fn journey_fork_close(
    request: RequestForkCloseRequest,
    job_id: String,
) -> Result<ReviewJob, String> {
    tokio::task::spawn_blocking(move || {
        let session = agent_core::session::persistence::get_session(&request.session_id)
            .map_err(|error| format!("无法读取会话运行来源：{error}"))?
            .ok_or_else(|| "无法读取会话运行来源：会话不存在。".to_string())?;
        let model_id = session
            .model
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "无法关闭分叉：会话缺少模型来源。".to_string())?;
        let account_id = session
            .account_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "无法关闭分叉：会话缺少账户来源。".to_string())?;
        let protocol = key_vault::key_store::KEY_SERVICE
            .get_key_by_id(&account_id)
            .and_then(|key| key.protocol)
            .map(|protocol| protocol.as_str().to_string())
            .ok_or_else(|| "无法关闭分叉：账户缺少协议来源。".to_string())?;
        let provenance = RuntimeProvenance {
            model_id,
            account_id,
            protocol,
        };
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::request_fork_close_and_enqueue(
            &mut conn, request, job_id, provenance,
        )
        .map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程分叉关闭异常：{error}"))?
}

/// Re-queues a failed review using the same durable application service and
/// compare-and-swap revision contract as every other Journey mutation.
#[tauri::command]
pub async fn journey_review_retry(
    request: RetryReviewRequest,
) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::retry_review(&mut conn, request).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程审核重试异常：{error}"))?
}

#[tauri::command]
pub async fn journey_review_list(
    session_id: String,
) -> Result<Vec<agent_core::core::journey_lifecycle::ReviewItem>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_connection()?;
        SessionJourneyApplicationService::review_queue(&conn, &session_id).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程审核列表异常：{error}"))?
}

#[tauri::command]
pub async fn journey_fork_compare(session_id: String) -> Result<ForkCompareResponse, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_connection()?;
        SessionJourneyApplicationService::fork_compare(&conn, &session_id).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程分叉对比异常：{error}"))?
}

#[tauri::command]
pub async fn journey_ready_draft(
    session_id: String,
    review_id: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_connection()?;
        SessionJourneyApplicationService::get_review_draft(&conn, &session_id, &review_id)
            .map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程审核草稿查询异常：{error}"))?
}

#[tauri::command]
pub async fn journey_confirm(request: PromoteFactRequest) -> Result<JourneyWriteResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::promote_confirmed_fact(&mut conn, request)
            .map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程审核确认异常：{error}"))?
}

#[tauri::command]
pub async fn journey_discard(request: DiscardForkRequest) -> Result<DiscardForkResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::discard_fork(&mut conn, request).map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程分叉丢弃异常：{error}"))?
}

#[tauri::command]
pub async fn journey_return_parent(
    request: ReturnToParentRequest,
) -> Result<ReturnToParentResponse, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_connection()?;
        SessionJourneyApplicationService::return_to_parent(&mut conn, request)
            .map_err(service_error)
    })
    .await
    .map_err(|error| format!("会话旅程返回主分支异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::service_error;
    use agent_core::session::journey_application_service::{
        CreateCheckpointRequest, CreateForkRequest, CreateTaskRequest, DiscardForkRequest,
        FinishTaskRequest, ForkCompareGroup, ForkCompareItem, ForkCompareResponse, ForkCompareTask,
        PromoteFactRequest, RequestForkCloseRequest, RetryReviewRequest, ReturnToParentRequest,
        TaskStartPosition,
    };

    #[test]
    fn errors_have_a_deterministic_chinese_command_prefix() {
        assert_eq!(service_error("原始错误"), "会话旅程操作失败：原始错误");
    }

    #[test]
    fn task_start_accepts_a_typed_revisioned_request() {
        let request: CreateTaskRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "expectedRevision": 4,
            "taskId": "task-1",
            "name": "核对锚点",
            "position": "最近用户消息"
        }))
        .expect("command request must remain typed");
        assert_eq!(request.session_id, "session-1");
        assert_eq!(request.expected_revision, 4);
        assert_eq!(request.position, TaskStartPosition::最近用户消息);
    }

    #[test]
    fn all_desktop_mutation_requests_use_tauri_camel_case_fields() {
        let payloads = [
            serde_json::to_value(CreateTaskRequest {
                session_id: "s".into(),
                expected_revision: 1,
                task_id: "t".into(),
                name: "任务".into(),
                position: TaskStartPosition::下一条用户消息,
            })
            .unwrap(),
            serde_json::to_value(CreateForkRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f".into(),
                task_id: "t".into(),
                task_name: "分叉任务".into(),
                anchor_message_id: Some("m".into()),
            })
            .unwrap(),
            serde_json::to_value(CreateCheckpointRequest {
                session_id: "s".into(),
                expected_revision: 1,
                checkpoint_id: "c".into(),
                name: "检查点".into(),
                message_id: "m".into(),
            })
            .unwrap(),
            serde_json::to_value(FinishTaskRequest {
                session_id: "s".into(),
                expected_revision: 1,
                outcome: agent_core::core::journey_lifecycle::TaskOutcome::Completed,
                message_id: "m".into(),
            })
            .unwrap(),
            serde_json::to_value(RequestForkCloseRequest {
                session_id: "s".into(),
                expected_revision: 1,
                fork_id: "f".into(),
                review_id: "r".into(),
                outcome: agent_core::core::journey_lifecycle::TaskOutcome::Completed,
                message_id: "m".into(),
            })
            .unwrap(),
            serde_json::to_value(PromoteFactRequest {
                session_id: "s".into(),
                expected_revision: 1,
                review_id: "r".into(),
                fact_id: "fact".into(),
                text: "确认".into(),
                evidence_start_message_id: "a".into(),
                evidence_end_message_id: "b".into(),
            })
            .unwrap(),
            serde_json::to_value(DiscardForkRequest {
                session_id: "s".into(),
                expected_revision: 1,
                review_id: "r".into(),
            })
            .unwrap(),
            serde_json::to_value(ReturnToParentRequest {
                session_id: "s".into(),
                expected_revision: 1,
                review_id: "r".into(),
            })
            .unwrap(),
            serde_json::to_value(RetryReviewRequest {
                session_id: "s".into(),
                expected_revision: 1,
                review_id: "r".into(),
            })
            .unwrap(),
        ];
        for payload in payloads {
            let serialized = payload.to_string();
            assert!(!serialized.contains("session_id"), "{serialized}");
            assert!(!serialized.contains("expected_revision"), "{serialized}");
            assert!(serialized.contains("sessionId"), "{serialized}");
            assert!(serialized.contains("expectedRevision"), "{serialized}");
        }
        let direct_fork = serde_json::to_value(CreateForkRequest {
            session_id: "s".into(),
            expected_revision: 1,
            fork_id: "f".into(),
            task_id: "t".into(),
            task_name: "直接分叉".into(),
            anchor_message_id: None,
        })
        .unwrap();
        assert!(
            !direct_fork
                .as_object()
                .unwrap()
                .contains_key("anchorMessageId"),
            "omitting the desktop direct-Fork anchor must serialize as an absent optional field"
        );
    }

    #[test]
    fn fork_compare_dto_uses_the_same_snake_case_fields_as_the_typed_client() {
        let payload = serde_json::to_value(ForkCompareResponse {
            groups: vec![ForkCompareGroup {
                parent_branch_id: "main".into(),
                parent_anchor_message_id: Some("message-1".into()),
                anchor_sequence: 1,
                forks: vec![ForkCompareItem {
                    branch_id: "fork-a".into(),
                    branch_name: "fork-a".into(),
                    state: agent_core::core::journey_lifecycle::ForkState::Active,
                    tasks: vec![ForkCompareTask {
                        task_id: "task-a".into(),
                        name: "核对".into(),
                        state: agent_core::core::journey_lifecycle::TaskState::Active,
                        outcome: None,
                    }],
                    task_outcome: None,
                    conclusion: None,
                    unresolved: vec![],
                    evidence: vec![],
                }],
            }],
        })
        .unwrap();
        let group = &payload["groups"][0];
        let fork = &group["forks"][0];
        let task = &fork["tasks"][0];
        for key in [
            "parent_branch_id",
            "parent_anchor_message_id",
            "anchor_sequence",
        ] {
            assert!(group.get(key).is_some(), "missing group key {key}");
        }
        for key in ["branch_id", "branch_name", "task_outcome"] {
            assert!(fork.get(key).is_some(), "missing fork key {key}");
        }
        assert!(task.get("task_id").is_some());
        assert!(task.get("taskId").is_none());
    }

    #[test]
    fn every_journey_adapter_is_registered_once_for_tauri() {
        let handlers = include_str!("../commands/handler_list.inc");
        for command in [
            "journey_snapshot",
            "journey_task_start",
            "journey_checkpoint",
            "journey_task_finish",
            "journey_fork_start",
            "journey_fork_close",
            "journey_review_retry",
            "journey_review_list",
            "journey_ready_draft",
            "journey_confirm",
            "journey_discard",
            "journey_return_parent",
        ] {
            assert_eq!(
                handlers.matches(command).count(),
                1,
                "{command} must have one desktop adapter registration"
            );
        }
    }
}
