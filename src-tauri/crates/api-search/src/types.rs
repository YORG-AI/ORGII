//! Request/response types for the search HTTP API.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiInfo {
    pub name: String,
    pub version: String,
    pub status: String,
    pub endpoints: EndpointsList,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EndpointsList {
    pub openapi_spec: String,
    pub file_search: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSearchQuery {
    pub query: String,
    pub root_path: String,
    pub max_results: Option<usize>,
    pub file_extensions: Option<Vec<String>>,
    pub exclude_dirs: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSearchResult {
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub score: i64,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSearchResponse {
    pub files: Vec<FileSearchResult>,
    pub folders: Vec<FileSearchResult>,
    pub total_indexed: usize,
    pub search_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileIndexRequest {
    pub root_path: String,
    pub exclude_dirs: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileIndexResponse {
    pub count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SymbolSearchQuery {
    pub repo_path: String,
    pub query: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ApiSymbolInfo {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SymbolSearchResponse {
    pub symbols: Vec<ApiSymbolInfo>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSymbolsQuery {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSymbol {
    pub name: String,
    pub kind: String,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schema(no_recursion)]
    pub children: Vec<FileSymbol>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FileSymbolsResponse {
    pub file_path: String,
    pub language: String,
    pub symbols: Vec<FileSymbol>,
    pub parse_time_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_search_result_serializes_file_type_under_type_key() {
        let result = FileSearchResult {
            path: "/repo/src/lib.rs".to_string(),
            file_type: "file".to_string(),
            score: 42,
            filename: "lib.rs".to_string(),
        };

        let json = serde_json::to_value(result).expect("serialize result");

        assert_eq!(json["type"], "file");
        assert!(json.get("file_type").is_none());
    }

    #[test]
    fn file_symbol_children_default_when_absent_and_omit_when_empty() {
        let symbol: FileSymbol = serde_json::from_value(serde_json::json!({
            "name": "alpha",
            "kind": "function",
            "line": 1,
            "column": 4,
            "end_line": 1,
            "end_column": 9
        }))
        .expect("deserialize symbol");
        assert!(symbol.children.is_empty());

        let json = serde_json::to_value(symbol).expect("serialize symbol");
        assert!(json.get("children").is_none());
    }
}
