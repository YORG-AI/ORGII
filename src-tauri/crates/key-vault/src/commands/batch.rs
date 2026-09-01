
/// Summary of key validation
#[derive(serde::Serialize)]
pub struct KeyValidationSummary {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub format_valid: bool,
    pub format_message: String,
    pub api_valid: Option<bool>,
    pub api_message: Option<String>,
    pub models_count: Option<usize>,
}
