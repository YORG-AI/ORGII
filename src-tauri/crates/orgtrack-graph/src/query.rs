use orgtrack_sync::{GraphEdgeType, GraphNodeType};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JourneyScope {
    Project(String),
    Session(String),
}

impl JourneyScope {
    pub fn parse(scope: &str) -> Result<Self, String> {
        let (kind, id) = scope
            .split_once('/')
            .ok_or_else(|| "journey scope must be project/{id} or session/{id}".to_string())?;
        if id.is_empty() || id.contains('/') || id.chars().any(char::is_whitespace) {
            return Err("journey scope must have one non-empty id".to_string());
        }
        match kind {
            "project" => Ok(Self::Project(id.to_owned())),
            "session" => Ok(Self::Session(id.to_owned())),
            _ => Err("journey scope must be project/{id} or session/{id}".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphDirection {
    Outgoing,
    Incoming,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNeighbor {
    pub node_id: String,
    pub node_type: GraphNodeType,
    pub stable_key: String,
    pub node_payload: Value,
    pub edge_id: String,
    pub edge_type: GraphEdgeType,
    pub confidence: f32,
    pub edge_payload: Value,
}
