//! Durable Session Journey lifecycle aggregate -> canonical graph projection.
//! Exact boundaries are verified through membership rows; no timestamp inference.

use agent_core::core::journey_lifecycle::{ReviewState, SessionJourney};
use orgtrack_graph::{
    CoverageEntry, CoverageStatus, EvidenceClass, JourneyEdge, JourneyEdgeKind, JourneyGraph,
    JourneyNode, JourneyNodeKind,
};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

fn sid(session: &str, kind: &str, id: &str) -> String {
    format!("journey/{session}/{kind}/{id}")
}
fn src(session: &str, kind: &str, id: &str) -> String {
    format!("session-journey:{session}:{kind}:{id}")
}
fn node(
    g: &mut JourneyGraph,
    ids: &mut HashSet<String>,
    id: String,
    kind: JourneyNodeKind,
    evidence: EvidenceClass,
    source: String,
) -> Result<(), String> {
    if id.trim().is_empty() || source.trim().is_empty() {
        return Err("Journey lifecycle identity is empty".into());
    }
    if !ids.insert(id.clone()) {
        return Err(format!("duplicate Journey lifecycle node: {id}"));
    }
    g.nodes.push(JourneyNode {
        id,
        kind,
        evidence_class: evidence,
        source_ref: source.clone(),
        display_timestamp: None,
    });
    g.coverage.push(CoverageEntry {
        source_ref: source,
        status: CoverageStatus::Represented,
    });
    Ok(())
}
fn edge(
    g: &mut JourneyGraph,
    from: String,
    to: String,
    kind: JourneyEdgeKind,
    evidence: EvidenceClass,
    source: String,
) {
    g.edges.push(JourneyEdge {
        from,
        to,
        kind,
        evidence_class: evidence,
        source_ref: source,
    });
}

/// A JSON aggregate is only structurally trustworthy when each map key agrees
/// with the immutable ID carried by its entity. Otherwise later reference
/// checks can accept a map key while graph IDs are built from a different ID,
/// creating an unverifiable dangling edge.
fn verify_record_key(kind: &str, key: &str, entity_id: &str) -> Result<(), String> {
    if key != entity_id || entity_id.trim().is_empty() {
        return Err(format!(
            "Journey {kind} 存储键与实体 ID 不一致：key={key}, id={entity_id}"
        ));
    }
    Ok(())
}

fn message_anchor(
    conn: &Connection,
    g: &mut JourneyGraph,
    ids: &mut HashSet<String>,
    session: &str,
    message: &str,
    sequence: u64,
) -> Result<String, String> {
    let found:Option<i64>=conn.query_row("SELECT sequence FROM session_journey_memberships WHERE session_id=?1 AND message_id=?2",(session,message),|r|r.get(0)).optional().map_err(|e|format!("读取 Journey 精确锚点失败：{e}"))?;
    if found != Some(sequence as i64) {
        return Err(format!("Journey 精确锚点不一致：session={session}, message={message}, expected_sequence={sequence}"));
    }
    let id = sid(session, "message", message);
    if !ids.contains(&id) {
        node(
            g,
            ids,
            id.clone(),
            JourneyNodeKind::MessageAnchor,
            EvidenceClass::Canonical,
            format!("session-journey-membership:{session}:{message}:{sequence}"),
        )?;
    }
    Ok(id)
}
pub fn append(conn: &Connection, g: &mut JourneyGraph, j: &SessionJourney) -> Result<(), String> {
    let session_node = format!("session/{}", j.session_id);
    if !g.nodes.iter().any(|n| n.id == session_node) {
        return Err(format!(
            "Journey aggregate has no canonical session: {}",
            j.session_id
        ));
    }
    let mut ids = g.nodes.iter().map(|n| n.id.clone()).collect::<HashSet<_>>();
    for (key, b) in &j.branches {
        verify_record_key("分支", key, &b.id)?;
        let id = sid(&j.session_id, "branch", &b.id);
        let source = src(&j.session_id, "branch", &b.id);
        node(
            g,
            &mut ids,
            id.clone(),
            JourneyNodeKind::Branch,
            EvidenceClass::Canonical,
            source.clone(),
        )?;
        edge(
            g,
            session_node.clone(),
            id.clone(),
            JourneyEdgeKind::Contains,
            EvidenceClass::Canonical,
            source.clone(),
        );
        if b.parent_branch_id != b.id {
            let expected_source_start = b
                .anchor_sequence
                .checked_add(1)
                .ok_or_else(|| format!("Journey 分叉 {} 的父锚点序号溢出", b.id))?;
            if b.source_start_sequence != expected_source_start {
                return Err(format!(
                    "Journey 分叉 {} 的来源起点 {} 与父锚点 {} 不连续",
                    b.id, b.source_start_sequence, b.anchor_sequence
                ));
            }
            if let Some(end) = b.frozen_end_sequence {
                if end < b.source_start_sequence {
                    return Err(format!(
                        "Journey 分叉 {} 的冻结终点 {} 早于来源起点 {}",
                        b.id, end, b.source_start_sequence
                    ));
                }
            }
            if !j.branches.contains_key(&b.parent_branch_id) {
                return Err(format!("Journey 分叉 {} 缺少父分支", b.id));
            }
            edge(
                g,
                sid(&j.session_id, "branch", &b.parent_branch_id),
                id.clone(),
                JourneyEdgeKind::ForkedFrom,
                EvidenceClass::Canonical,
                source.clone(),
            );
            let message = b
                .parent_anchor_message_id
                .as_deref()
                .ok_or_else(|| format!("Journey 分叉 {} 缺少精确父消息锚点", b.id))?;
            let anchor =
                message_anchor(conn, g, &mut ids, &j.session_id, message, b.anchor_sequence)?;
            edge(
                g,
                id,
                anchor,
                JourneyEdgeKind::AnchoredAt,
                EvidenceClass::Canonical,
                source,
            );
        }
    }
    for (key, t) in &j.tasks {
        verify_record_key("任务", key, &t.id)?;
        if !j.branches.contains_key(&t.branch_id) {
            return Err(format!("Journey 任务 {} 缺少所属分支", t.id));
        }
        match t.state {
            agent_core::core::journey_lifecycle::TaskState::PendingNextUser => {
                if t.start_sequence.is_some() || t.finish_sequence.is_some() || t.outcome.is_some()
                {
                    return Err(format!("Journey 待激活任务 {} 包含不允许的完成状态", t.id));
                }
            }
            agent_core::core::journey_lifecycle::TaskState::Active => {
                if t.start_sequence.is_none() || t.finish_sequence.is_some() || t.outcome.is_some()
                {
                    return Err(format!("Journey 活跃任务 {} 的状态字段不一致", t.id));
                }
            }
            agent_core::core::journey_lifecycle::TaskState::Finished => {
                if t.start_sequence.is_none() || t.finish_sequence.is_none() || t.outcome.is_none()
                {
                    return Err(format!("Journey 已完成任务 {} 缺少起止序号或结果", t.id));
                }
            }
        }
        if let (Some(start), Some(finish)) = (t.start_sequence, t.finish_sequence) {
            if start > finish {
                return Err(format!(
                    "Journey 任务 {} 的起止序号反向：start={} finish={}",
                    t.id, start, finish
                ));
            }
        }
        let id = sid(&j.session_id, "task", &t.id);
        let source = src(&j.session_id, "task", &t.id);
        node(
            g,
            &mut ids,
            id.clone(),
            JourneyNodeKind::Task,
            EvidenceClass::Canonical,
            source.clone(),
        )?;
        edge(
            g,
            sid(&j.session_id, "branch", &t.branch_id),
            id,
            JourneyEdgeKind::Contains,
            EvidenceClass::Canonical,
            source,
        );
    }
    for (key, c) in &j.checkpoints {
        verify_record_key("检查点", key, &c.id)?;
        if !j.tasks.contains_key(&c.task_id) {
            return Err(format!("Journey 检查点 {} 缺少所属任务", c.id));
        }
        let id = sid(&j.session_id, "checkpoint", &c.id);
        let source = src(&j.session_id, "checkpoint", &c.id);
        node(
            g,
            &mut ids,
            id.clone(),
            JourneyNodeKind::Checkpoint,
            EvidenceClass::Canonical,
            source.clone(),
        )?;
        edge(
            g,
            sid(&j.session_id, "task", &c.task_id),
            id.clone(),
            JourneyEdgeKind::Contains,
            EvidenceClass::Canonical,
            source.clone(),
        );
        let anchor = message_anchor(conn, g, &mut ids, &j.session_id, &c.message_id, c.sequence)?;
        edge(
            g,
            id,
            anchor,
            JourneyEdgeKind::AnchoredAt,
            EvidenceClass::Canonical,
            source,
        );
    }
    for (key, r) in &j.reviews {
        verify_record_key("审阅", key, &r.id)?;
        if !j.branches.contains_key(&r.fork_id) {
            return Err(format!("Journey 审阅 {} 缺少所属分叉", r.id));
        }
        let branch = j
            .branches
            .get(&r.fork_id)
            .ok_or_else(|| format!("Journey 审阅 {} 缺少所属分叉", r.id))?;
        if r.source_start_sequence > r.source_end_sequence {
            return Err(format!(
                "Journey 审阅 {} 的来源范围反向：start={} end={}",
                r.id, r.source_start_sequence, r.source_end_sequence
            ));
        }
        if r.source_start_sequence != branch.source_start_sequence
            || branch.frozen_end_sequence != Some(r.source_end_sequence)
        {
            return Err(format!(
                "Journey 审阅 {} 的来源范围 {}..{} 与分叉 {} 的冻结范围不一致",
                r.id, r.source_start_sequence, r.source_end_sequence, r.fork_id
            ));
        }
        match r.state {
            ReviewState::Queued => {
                if r.annotation.is_some() || !r.promoted_fact_ids.is_empty() {
                    return Err(format!("Journey 待审核项 {} 包含已发布内容", r.id));
                }
            }
            ReviewState::Ready => {
                if r.provenance.is_none() || !r.promoted_fact_ids.is_empty() {
                    return Err(format!("Journey 可审核项 {} 的来源或确认状态不一致", r.id));
                }
            }
            ReviewState::Confirmed => {
                if r.provenance.is_none() || r.promoted_fact_ids.is_empty() {
                    return Err(format!("Journey 已确认审阅 {} 缺少来源或确认事实", r.id));
                }
            }
            ReviewState::Failed => {
                if r.annotation.is_some() || !r.promoted_fact_ids.is_empty() {
                    return Err(format!("Journey 失败审阅 {} 包含已发布内容", r.id));
                }
            }
            ReviewState::Discarded => {
                if !r.promoted_fact_ids.is_empty() {
                    return Err(format!("Journey 已丢弃审阅 {} 仍引用确认事实", r.id));
                }
            }
        }
        let id = sid(&j.session_id, "review", &r.id);
        let source = src(&j.session_id, "review", &r.id);
        node(
            g,
            &mut ids,
            id.clone(),
            JourneyNodeKind::Review,
            EvidenceClass::Canonical,
            source.clone(),
        )?;
        edge(
            g,
            sid(&j.session_id, "branch", &r.fork_id),
            id.clone(),
            JourneyEdgeKind::Reviews,
            EvidenceClass::Canonical,
            source,
        );
        // An annotation is a review projection, not immutable transcript.
        // Queued/failed/discarded reviews never publish it; discard may leave
        // the old serialized field behind, but it must not resurrect the AI
        // annotation in the canonical graph.
        if matches!(r.state, ReviewState::Ready | ReviewState::Confirmed) {
            let _annotation = r
                .annotation
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("Journey 审阅 {} 缺少有效 annotation", r.id))?;
            let aid = sid(&j.session_id, "annotation", &r.id);
            let asrc = src(&j.session_id, "annotation", &r.id);
            node(
                g,
                &mut ids,
                aid.clone(),
                JourneyNodeKind::Annotation,
                EvidenceClass::AiAnnotation,
                asrc.clone(),
            )?;
            edge(
                g,
                id,
                aid,
                JourneyEdgeKind::Produced,
                EvidenceClass::AiAnnotation,
                asrc,
            );
        }
    }
    for (key, f) in &j.facts {
        verify_record_key("事实", key, &f.id)?;
        let review = j
            .reviews
            .get(&f.review_id)
            .ok_or_else(|| format!("Journey 已确认事实 {} 缺少来源审阅", f.id))?;
        if review.state != ReviewState::Confirmed
            || !review
                .promoted_fact_ids
                .iter()
                .any(|fact_id| fact_id == &f.id)
        {
            return Err(format!("Journey 已确认事实 {} 与来源审阅状态不一致", f.id));
        }
        if f.evidence_start_message_id.trim().is_empty()
            || f.evidence_end_message_id.trim().is_empty()
        {
            return Err(format!(
                "Journey 已确认事实 {} 的证据消息 ID 不能为空",
                f.id
            ));
        }
        if f.evidence_start_sequence > f.evidence_end_sequence {
            return Err(format!(
                "Journey 已确认事实 {} 的证据序号范围反向：start={} end={}",
                f.id, f.evidence_start_sequence, f.evidence_end_sequence
            ));
        }
        if f.evidence_start_sequence < review.source_start_sequence
            || f.evidence_end_sequence > review.source_end_sequence
        {
            return Err(format!(
                "Journey 已确认事实 {} 的证据范围 {}..{} 超出来源审阅范围 {}..{}",
                f.id,
                f.evidence_start_sequence,
                f.evidence_end_sequence,
                review.source_start_sequence,
                review.source_end_sequence
            ));
        }
        let id = sid(&j.session_id, "fact", &f.id);
        let source = src(&j.session_id, "fact", &f.id);
        node(
            g,
            &mut ids,
            id.clone(),
            JourneyNodeKind::ConfirmedFact,
            EvidenceClass::Canonical,
            source.clone(),
        )?;
        edge(
            g,
            sid(&j.session_id, "review", &f.review_id),
            id.clone(),
            JourneyEdgeKind::PromotedFrom,
            EvidenceClass::Canonical,
            source.clone(),
        );
        for (message_id, seq) in [
            (&f.evidence_start_message_id, f.evidence_start_sequence),
            (&f.evidence_end_message_id, f.evidence_end_sequence),
        ] {
            let anchor = message_anchor(conn, g, &mut ids, &j.session_id, message_id, seq)?;
            edge(
                g,
                id.clone(),
                anchor,
                JourneyEdgeKind::EvidenceAt,
                EvidenceClass::Canonical,
                source.clone(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_core::core::journey_lifecycle::SessionJourney;

    #[test]
    fn lifecycle_nodes_attach_to_the_canonical_session_not_a_work_item() {
        let conn = Connection::open_in_memory().unwrap();
        let mut graph = JourneyGraph {
            nodes: vec![JourneyNode {
                id: "session/s".into(),
                kind: JourneyNodeKind::Session,
                evidence_class: EvidenceClass::Canonical,
                source_ref: "canonical-session:s".into(),
                display_timestamp: None,
            }],
            ..JourneyGraph::default()
        };

        append(&conn, &mut graph, &SessionJourney::new("s", "main")).unwrap();

        assert!(graph.edges.iter().any(|edge| {
            edge.from == "session/s"
                && edge.to == "journey/s/branch/main"
                && edge.kind == JourneyEdgeKind::Contains
        }));
        assert!(graph.edges.iter().all(|edge| {
            !(edge.kind == JourneyEdgeKind::Contains
                && (edge.from.starts_with("work_item/") || edge.to.starts_with("work_item/")))
        }));
    }
}
