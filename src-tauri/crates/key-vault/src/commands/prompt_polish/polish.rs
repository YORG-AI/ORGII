//! The `prompt_polish` Tauri command and its MiniCPM output-quality guards.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::key_store::ModelKey;

use super::client::{
    chat_completions_url, content_value_to_string, key_base_url, minicpm_no_think_kwargs,
    provider_error_message, select_prompt_polish_account, with_optional_bearer,
    ChatCompletionMessage, ChatCompletionRequest, ChatCompletionResponse,
};
use super::text::{
    is_greeting_like, is_short_text, normalized_short_input, strip_reasoning_artifacts,
};
use super::POLISH_REQUEST_TIMEOUT_SECONDS;

const MAX_POLISH_INPUT_CHARS: usize = 6_000;
const POLISH_MAX_TOKENS: u32 = 768;
const HOUSEKEEPER_POLISH_SYSTEM_PROMPT: &str = r#"你是 ORG2 的本地 MiniCPM 常驻管家。
你的唯一任务：把用户草稿改写成一条更适合发送给强代码 Agent 的任务请求。

硬性规则：
1. 只输出最终润色后的请求，不要回答用户，不要解释规则，不要寒暄。
2. 用户用中文就输出中文，用户用英文就输出英文。
3. 必须保留用户原文中的关键名词、文件名、路径、命令、代码片段、URL、模型名和 [[ORGII_PILL_0]] 这类占位符。
4. 不输出 <think>、analysis、reasoning、Markdown 代码块或“以下是改写后”这类包装文字。
5. 如果原文很短、口语化或只说了一个现象，必须扩写成可执行任务，覆盖目标、排查/实现范围、验证方式和交付说明。
6. 不要编造不存在的事实；不确定的信息写成“请根据当前上下文确认”。
"#;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPolishRequest {
    pub text: String,
    pub account_id: Option<String>,
    pub model: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPolishResponse {
    pub polished_text: String,
    pub model: String,
    pub account_id: String,
}
fn is_identity_question(text: &str) -> bool {
    let normalized = normalized_short_input(text);
    [
        "你是谁",
        "您是谁",
        "你是什么",
        "你是什么模型",
        "你是哪个模型",
        "who are you",
        "what are you",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}
fn is_capability_question(text: &str) -> bool {
    let normalized = normalized_short_input(text);
    [
        "你能干嘛",
        "你能做什么",
        "你可以做什么",
        "能干嘛",
        "能做啥",
        "会什么",
        "what can you do",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase))
}
fn normalized_task_input(text: &str) -> String {
    normalized_short_input(text)
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect()
}
fn is_backend_optimization_request(text: &str) -> bool {
    let normalized = normalized_task_input(text);
    normalized.contains("后端") && (normalized.contains("优化") || normalized.contains("改进"))
}
fn is_project_assessment_request(text: &str) -> bool {
    let normalized = normalized_task_input(text);
    normalized.contains("项目")
        && (normalized.contains("怎么样")
            || normalized.contains("如何")
            || normalized.contains("评估")
            || normalized.contains("现状"))
}
fn is_repeated_error_request(text: &str) -> bool {
    let normalized = normalized_task_input(text);
    (normalized.contains("出错") || normalized.contains("报错") || normalized.contains("错误"))
        && (normalized.contains("为什么")
            || normalized.contains("老是")
            || normalized.contains("总是")
            || normalized.contains("一直")
            || normalized.contains("频繁"))
}
fn is_prompt_polish_quality_request(text: &str) -> bool {
    let normalized = normalized_task_input(text);
    (normalized.contains("润色") || normalized.contains("改写") || normalized.contains("polish"))
        && (normalized.contains("出错")
            || normalized.contains("报错")
            || normalized.contains("错误")
            || normalized.contains("失败")
            || normalized.contains("不好")
            || normalized.contains("不行")
            || normalized.contains("很差")
            || normalized.contains("太差")
            || normalized.contains("效果差")
            || normalized.contains("质量差")
            || normalized.contains("老是"))
}
fn known_task_expansion_fallback(original_text: &str) -> Option<String> {
    if is_prompt_polish_quality_request(original_text) {
        return Some(
            r#"请排查并优化 ORG2 的输入/输出润色功能质量问题。请先根据当前上下文确认润色按钮的前端调用链、常驻管家配置、prompt_polish RPC、MiniCPM/vLLM 请求体、返回内容清洗和本地质量兜底逻辑；重点判断问题是模型输出过短、误回答用户、返回 Markdown/解释包装、没有保留原文关键词，还是兜底策略过于泛化。请在不引入完整 Agent 上下文、不发送 tools、不扩大 MiniCPM 请求负担的前提下，优化润色 prompt、质量判定和兜底策略，让短口语输入也能被改写成清晰、具体、可执行的代码 Agent 指令。完成后请用典型输入验证效果，并说明改动点、验证结果以及 MiniCPM 1B 仍然存在的能力边界。"#
                .to_string(),
        );
    }

    if is_backend_optimization_request(original_text) {
        return Some(
            r#"对现有后端系统进行全面优化，具体执行以下任务：
1. 性能优化：分析接口响应时间，优化数据库查询语句，添加必要的索引，实现接口缓存策略，将核心接口平均响应时间降低30%以上
2. 代码质量优化：重构冗余、重复的代码模块，统一代码规范，添加详细的接口文档和注释，提升代码可维护性
3. 稳定性优化：完善错误处理机制，添加日志埋点和监控告警，修复已知的线上bug，将系统可用性提升至99.9%以上
4. 安全性优化：排查并修复潜在的安全漏洞，强化接口权限校验，优化敏感数据加密存储方案
5. 测试验证：完成优化后编写对应的单元测试和集成测试，进行压力测试验证优化效果，确保所有核心业务流程正常运行，输出优化前后的性能对比报告"#
                .to_string(),
        );
    }

    if is_project_assessment_request(original_text) {
        return Some(
            r#"请针对当前正在推进的项目，从以下维度开展全面的现状调研与评估分析并形成正式评估报告：
1. 项目核心目标与当前完成进度的匹配度：梳理已明确的阶段性里程碑，统计各里程碑的实际完成占比，识别已滞后节点的具体滞后时长与影响范围
2. 资源配置效率分析：评估人力、财力、技术工具等核心资源的投入产出比，排查资源分配失衡、闲置或不足的具体环节
3. 风险与问题盘点：梳理当前项目推进中存在的技术风险、沟通壁垒、需求变更等各类问题，按影响程度分级标注并说明已采取的应对措施
4. 质量达标情况：对照项目初期设定的功能完整性、性能指标、合规性要求等质量标准，核查未达标的具体项并分析成因
最终提交的评估报告需包含量化的进度数据、问题分级清单、资源优化建议以及下一阶段的推进调整方案，确保全面清晰地呈现项目的真实运行状态。"#
                .to_string(),
        );
    }

    if is_repeated_error_request(original_text) {
        return Some(
            "请你详细说明当前开发场景中具体出现的错误信息、错误触发的操作流程、涉及的代码文件或功能模块，以及错误出现的频率和相关的环境信息（包括开发环境、运行环境、使用的技术栈版本等），以便全面排查导致程序频繁出错的根本原因，制定针对性的修复方案，完成问题的彻底解决并验证修复效果。"
                .to_string(),
        );
    }

    None
}
fn contains_request_signal(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "请",
        "帮",
        "希望",
        "需要",
        "围绕",
        "基于",
        "说明",
        "分析",
        "实现",
        "修改",
        "优化",
        "生成",
        "write",
        "help",
        "please",
        "explain",
        "analyze",
        "implement",
        "fix",
        "optimize",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
}
fn looks_like_chatty_polish_output(polished_text: &str) -> bool {
    let text = polished_text.trim();
    let lower = text.to_lowercase();
    [
        "当然可以",
        "以下是",
        "改写后",
        "原句",
        "这样改写",
        "希望这能帮到你",
        "it looks like",
        "could you please",
        "please provide",
        "provide more context",
        "i don't see",
        "i apologize",
        "i'm here to help",
        "not sure what you're asking",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
        || text.contains("---")
        || text.contains("**")
}
fn looks_like_underexpanded_generic_task(original_text: &str, polished_text: &str) -> bool {
    if !is_short_text(original_text) {
        return false;
    }

    let cleaned = polished_text.trim();
    let char_count = cleaned.chars().count();
    if char_count >= 80 {
        return false;
    }

    let lower = cleaned.to_lowercase();
    [
        "请帮我修复",
        "请修复",
        "请检查并修复",
        "请优化",
        "请改进",
        "please fix",
        "please improve",
        "fix the issue",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
        || char_count < 40
}
fn looks_like_direct_answer(original_text: &str, polished_text: &str) -> bool {
    if !is_short_text(original_text) {
        return false;
    }

    let cleaned = polished_text
        .trim()
        .trim_matches(|ch: char| ch.is_ascii_punctuation() || ch.is_whitespace());
    if cleaned.is_empty() || contains_request_signal(cleaned) {
        return false;
    }

    let lower_original = original_text.trim().to_lowercase();
    let lower_cleaned = cleaned.to_lowercase();

    if is_identity_question(&lower_original)
        && (lower_cleaned.starts_with("我是")
            || lower_cleaned.starts_with("我是一个")
            || lower_cleaned.starts_with("i am")
            || lower_cleaned.starts_with("i'm")
            || lower_cleaned.contains("作为一个"))
    {
        return true;
    }

    if is_capability_question(&lower_original)
        && (lower_cleaned.starts_with("我可以")
            || lower_cleaned.starts_with("我能")
            || lower_cleaned.contains("可以帮你")
            || lower_cleaned.starts_with("i can"))
    {
        return true;
    }

    if !is_short_text(polished_text) || contains_request_signal(cleaned) {
        return false;
    }

    is_greeting_like(&lower_original)
        || matches!(
            lower_cleaned.as_str(),
            "hello" | "hi" | "hey" | "你好" | "您好" | "不客气" | "you're welcome"
        )
}
fn looks_like_prompt_meta_output(original_text: &str, polished_text: &str) -> bool {
    if !is_short_text(original_text) {
        return false;
    }

    let text = polished_text.trim();
    let lower = text.to_lowercase();
    [
        "例如",
        "比如",
        "可以询问",
        "进行询问",
        "您提供的信息",
        "提供的信息或身份",
        "用户原始输入",
        "原始输入",
        "教用户",
        "改写成",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
        || text.contains("”或“")
        || text.contains("或“")
        || text.contains("或者“")
}
fn looks_like_underexpanded_known_task(original_text: &str, polished_text: &str) -> bool {
    known_task_expansion_fallback(original_text).is_some()
        && polished_text.trim().chars().count() < 120
}
fn fallback_polish_for_short_answer(original_text: &str) -> String {
    if let Some(fallback) = known_task_expansion_fallback(original_text) {
        return fallback;
    }

    if is_greeting_like(original_text) {
        return "请用中文回应我的问候，并简要说明接下来可以如何帮助我。".to_string();
    }

    if is_identity_question(original_text) {
        return "请用中文介绍你的身份、能力范围，以及你可以如何帮助我。".to_string();
    }

    if is_capability_question(original_text) {
        return "请说明你可以完成哪些类型的任务，并给出几个我可以继续提问的方向。".to_string();
    }

    format!(
        "请根据当前上下文围绕“{}”完成一次清晰的任务处理：先确认目标和现象，梳理相关模块、文件、配置或交互流程，定位需要调整的实现或说明，完成必要修改后进行验证，并在结果中说明改动点、验证方式和仍需我确认的信息。",
        original_text.trim()
    )
}
fn sanitize_polished_text(original_text: &str, polished_text: &str) -> Result<String, String> {
    let cleaned = strip_reasoning_artifacts(polished_text);
    if cleaned.trim().is_empty() {
        return Err("MiniCPM returned only reasoning text".to_string());
    }

    if looks_like_direct_answer(original_text, &cleaned)
        || looks_like_prompt_meta_output(original_text, &cleaned)
        || looks_like_underexpanded_known_task(original_text, &cleaned)
        || looks_like_chatty_polish_output(&cleaned)
        || looks_like_underexpanded_generic_task(original_text, &cleaned)
    {
        return Ok(fallback_polish_for_short_answer(original_text));
    }

    Ok(cleaned)
}
fn build_polish_user_prompt(text: &str) -> String {
    format!(
        r#"请把下面这段【用户原始输入】润色成一条将发送给强代码 Agent 的任务请求。

质量标准：
1. 只输出最终请求，不要解释，不要回答用户，不要写“以下是”。
2. 必须保留原文里的关键名词和问题现象。
3. 不要只做同义改写；如果原文很短，要补充目标、排查/实现范围、验证方式和交付说明。
4. 输出应当能直接发给代码 Agent 执行。

合格示例：
用户原始输入：为什么 Docker 一直重连
润色输出：请排查 Docker 服务一直重连的问题，先确认 Docker Desktop、WSL 和相关容器的运行状态，再查看日志中是否存在端口占用、镜像启动失败、GPU/CUDA 或网络连接错误；定位根因后完成修复，并说明修改内容、验证命令和仍需用户确认的环境信息。

【用户原始输入】
{text}

【输出】
只输出润色后的最终请求："#
    )
}
fn extract_polished_text(
    response: ChatCompletionResponse,
    original_text: &str,
) -> Result<String, String> {
    let content = response
        .choices
        .into_iter()
        .find_map(|choice| {
            choice
                .message
                .and_then(|message| message.content)
                .and_then(content_value_to_string)
                .or(choice.text)
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "MiniCPM returned an empty polish result".to_string())?;

    sanitize_polished_text(original_text, &content)
}
async fn request_prompt_polish(key: &ModelKey, model: &str, text: &str) -> Result<String, String> {
    let base_url = key_base_url(key)?;
    let endpoint = chat_completions_url(base_url)?;

    let user_prompt = build_polish_user_prompt(text);
    let body = ChatCompletionRequest {
        model,
        messages: vec![
            ChatCompletionMessage {
                role: "system",
                content: HOUSEKEEPER_POLISH_SYSTEM_PROMPT,
            },
            ChatCompletionMessage {
                role: "user",
                content: &user_prompt,
            },
        ],
        temperature: 0.2,
        max_tokens: POLISH_MAX_TOKENS,
        stream: false,
        chat_template_kwargs: minicpm_no_think_kwargs(),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(POLISH_REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|err| format!("Failed to create MiniCPM HTTP client: {err}"))?;

    let request = with_optional_bearer(client.post(endpoint).json(&body), key);

    let response = request
        .send()
        .await
        .map_err(|err| format!("MiniCPM request failed: {err}"))?;
    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read MiniCPM response: {err}"))?;

    if !status.is_success() {
        return Err(provider_error_message(status, &response_body));
    }

    let parsed = serde_json::from_str::<ChatCompletionResponse>(&response_body)
        .map_err(|err| format!("Failed to parse MiniCPM response: {err}"))?;
    extract_polished_text(parsed, text)
}
#[tauri::command]
pub async fn prompt_polish(request: PromptPolishRequest) -> Result<PromptPolishResponse, String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("No text to polish".to_string());
    }
    if text.chars().count() > MAX_POLISH_INPUT_CHARS {
        return Err(format!(
            "Text is too long for MiniCPM polish: max {MAX_POLISH_INPUT_CHARS} characters"
        ));
    }

    let account_id = request.account_id.clone();
    let model = request.model.clone();
    let selection = tokio::task::spawn_blocking(move || {
        select_prompt_polish_account(account_id.as_deref(), model.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))??;

    let polished_text = request_prompt_polish(&selection.key, &selection.model, text).await?;
    Ok(PromptPolishResponse {
        polished_text,
        model: selection.model,
        account_id: selection.key.id,
    })
}

#[cfg(test)]
mod tests {
    use super::super::client::{ChatCompletionChoice, ChatCompletionResponseMessage};
    use super::*;

    #[test]
    fn strips_think_blocks_from_polished_text() {
        let expected = "请梳理当前功能的目标、用户路径和相关实现，定位交互、状态管理与后端接口中的问题，完成必要的代码和文案修改；随后补充覆盖正常流程、异常状态与边界条件的单元测试和端到端验证，并说明具体改动、验证结果、兼容性影响以及仍需用户确认的风险。";
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(format!(
                        "<think>这部分不应该进入输入框</think>\n{expected}"
                    ))),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "优化功能").unwrap();

        assert_eq!(polished, expected);
    }

    #[test]
    fn falls_back_when_short_greeting_was_answered() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "<think>用户说你好，我应该回答 Hello</think>\nHello".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "你好").unwrap();

        assert_eq!(
            polished,
            "请用中文回应我的问候，并简要说明接下来可以如何帮助我。"
        );
    }

    #[test]
    fn keeps_valid_short_request_rewrite() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请用中文回应我的问候，并简要说明接下来可以如何帮助我。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "你好").unwrap();

        assert_eq!(
            polished,
            "请用中文回应我的问候，并简要说明接下来可以如何帮助我。"
        );
    }

    #[test]
    fn falls_back_when_identity_question_becomes_meta_instruction() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请围绕您提供的信息或身份进行询问，例如“请分享您的身份信息”或“您是谁？”"
                            .to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "你是谁").unwrap();

        assert_eq!(
            polished,
            "请用中文介绍你的身份、能力范围，以及你可以如何帮助我。"
        );
    }

    #[test]
    fn falls_back_when_identity_question_was_answered() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "我是一个人工智能助手，可以帮助你处理问题。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "你是谁").unwrap();

        assert_eq!(
            polished,
            "请用中文介绍你的身份、能力范围，以及你可以如何帮助我。"
        );
    }

    #[test]
    fn keeps_valid_identity_question_rewrite() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请用中文介绍你的身份、能力范围，以及你可以如何帮助我。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "你是谁").unwrap();

        assert_eq!(
            polished,
            "请用中文介绍你的身份、能力范围，以及你可以如何帮助我。"
        );
    }

    #[test]
    fn expands_underdeveloped_backend_optimization_request() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String("请帮我优化后端。".to_string())),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "给我优化一下后端").unwrap();

        assert!(polished.contains("对现有后端系统进行全面优化"));
        assert!(polished.contains("性能优化"));
        assert!(polished.contains("代码质量优化"));
        assert!(polished.contains("测试验证"));
    }

    #[test]
    fn expands_underdeveloped_project_assessment_request() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请评估一下当前项目。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "我们这个项目怎么样").unwrap();

        assert!(polished.contains("全面的现状调研与评估分析"));
        assert!(polished.contains("项目核心目标与当前完成进度"));
        assert!(polished.contains("资源配置效率分析"));
        assert!(polished.contains("下一阶段的推进调整方案"));
    }

    #[test]
    fn expands_underdeveloped_repeated_error_request() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请帮我排查频繁出错的问题。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "为什么老是出错").unwrap();

        assert!(polished.contains("具体出现的错误信息"));
        assert!(polished.contains("错误触发的操作流程"));
        assert!(polished.contains("使用的技术栈版本"));
        assert!(polished.contains("验证修复效果"));
    }

    #[test]
    fn expands_underdeveloped_prompt_polish_quality_request() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "请帮我检查并修复这段代码中的错误。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "给我修一下这个润色老是出错").unwrap();

        assert!(polished.contains("润色功能质量问题"));
        assert!(polished.contains("prompt_polish RPC"));
        assert!(polished.contains("MiniCPM/vLLM 请求体"));
        assert!(polished.contains("不发送 tools"));
        assert!(polished.contains("能力边界"));
    }

    #[test]
    fn falls_back_when_model_returns_chatty_polish_wrapper() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String(
                        "当然可以！以下是改写后的句子：\n\n**原句：** 给我修一下这个润色老是出错。\n\n**改写后：** 修一下这个润色，老是出错。".to_string(),
                    )),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "给我修一下这个润色老是出错").unwrap();

        assert!(!polished.contains("当然可以"));
        assert!(!polished.contains("改写后"));
        assert!(polished.contains("润色功能质量问题"));
        assert!(polished.contains("质量判定和兜底策略"));
    }

    #[test]
    fn generic_short_fallback_preserves_original_intent() {
        let response = ChatCompletionResponse {
            choices: vec![ChatCompletionChoice {
                message: Some(ChatCompletionResponseMessage {
                    content: Some(serde_json::Value::String("请修复这个问题。".to_string())),
                }),
                text: None,
            }],
        };

        let polished = extract_polished_text(response, "这个按钮不好用").unwrap();

        assert!(polished.contains("这个按钮不好用"));
        assert!(polished.contains("相关模块"));
        assert!(polished.contains("验证方式"));
    }
}
