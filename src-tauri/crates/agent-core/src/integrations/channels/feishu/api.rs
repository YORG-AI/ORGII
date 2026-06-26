//! Feishu REST API — send/update messages, media upload/download, reactions.

use serde_json::Value;
use tracing::warn;

use super::super::traits::ChannelError;
use super::auth::FeishuAuth;
use crate::bus::OutboundMessage;

/// Determine whether content should be sent as an interactive card.
fn should_use_card(content: &str, render_mode: &str) -> bool {
    match render_mode {
        "raw" => false,
        "card" => true,
        _ => {
            // "auto": use card if content contains code blocks or tables
            content.contains("```") || content.contains("|---|")
        }
    }
}

/// Build a Feishu interactive card JSON from markdown content.
fn build_card_content(content: &str) -> String {
    let card = serde_json::json!({
        "elements": [
            {
                "tag": "markdown",
                "content": content
            }
        ],
        "header": {
            "title": {
                "tag": "plain_text",
                "content": "Agent Response"
            }
        }
    });
    card.to_string()
}

/// Build a plain text message content JSON.
fn build_text_content(content: &str) -> String {
    serde_json::json!({ "text": content }).to_string()
}

/// Send a message to Feishu via REST API.
pub(super) async fn send_feishu_message(
    auth: &FeishuAuth,
    msg: &OutboundMessage,
    render_mode: &str,
) -> Result<(), ChannelError> {
    let token = auth.get_token().await?;

    let use_card = should_use_card(&msg.content, render_mode);
    let (msg_type, content_json) = if use_card {
        ("interactive", build_card_content(&msg.content))
    } else {
        ("text", build_text_content(&msg.content))
    };

    let body = serde_json::json!({
        "receive_id": msg.chat_id,
        "msg_type": msg_type,
        "content": content_json,
    });

    let url = if let Some(ref reply_to_id) = msg.reply_to {
        format!("{}/im/v1/messages/{}/reply", auth.api_base(), reply_to_id)
    } else {
        format!("{}/im/v1/messages?receive_id_type=chat_id", auth.api_base())
    };

    let res = auth
        .client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        warn!(
            "[feishu] Got {} on send, refreshing token and retrying",
            status
        );
        let new_token = auth.refresh_token().await?;

        let retry_res = auth
            .client()
            .post(&url)
            .header("Authorization", format!("Bearer {}", new_token))
            .json(&body)
            .send()
            .await
            .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

        let retry_json: Value = retry_res
            .json()
            .await
            .map_err(|err| ChannelError::SendFailed(format!("Invalid retry response: {}", err)))?;

        let code = retry_json
            .get("code")
            .and_then(|c| c.as_i64())
            .unwrap_or(-1);
        if code != 0 {
            let err_msg = retry_json
                .get("msg")
                .and_then(|m| m.as_str())
                .unwrap_or("Send failed after retry");
            return Err(ChannelError::SendFailed(err_msg.to_string()));
        }

        return Ok(());
    }

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::SendFailed(format!("Invalid send response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let err_msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Send failed");
        return Err(ChannelError::SendFailed(err_msg.to_string()));
    }

    Ok(())
}

// ── Media Upload/Download ───────────────────────────────────────────────

fn image_ext_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else {
        "bin"
    }
}

/// Download an image from Feishu by image_key. Returns raw bytes.
pub(super) async fn download_image(
    auth: &FeishuAuth,
    image_key: &str,
) -> Result<Vec<u8>, ChannelError> {
    let token = auth.get_token().await?;
    let url = format!("{}/im/v1/images/{}", auth.api_base(), image_key);

    let res = auth
        .client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|err| ChannelError::Other(format!("Download image failed: {}", err)))?;

    if !res.status().is_success() {
        return Err(ChannelError::Other(format!(
            "Download image HTTP {}: {}",
            res.status(),
            image_key
        )));
    }

    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|err| ChannelError::Other(format!("Read image bytes failed: {}", err)))
}

/// Download an image resource from a specific Feishu message. Rich-text/post
/// image elements are message resources, and `/im/v1/images/{image_key}` can
/// reject them with 400.
pub(super) async fn download_message_image(
    auth: &FeishuAuth,
    message_id: &str,
    image_key: &str,
) -> Result<Vec<u8>, ChannelError> {
    let token = auth.get_token().await?;
    let url = format!(
        "{}/im/v1/messages/{}/resources/{}?type=image",
        auth.api_base(),
        message_id,
        image_key
    );

    let res = auth
        .client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|err| ChannelError::Other(format!("Download message image failed: {}", err)))?;

    if !res.status().is_success() {
        return Err(ChannelError::Other(format!(
            "Download message image HTTP {}: message_id={}, image_key={}",
            res.status(),
            message_id,
            image_key
        )));
    }

    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|err| ChannelError::Other(format!("Read message image bytes failed: {}", err)))
}

/// Download a file from Feishu by file_key. Returns raw bytes.
pub(super) async fn download_file(
    auth: &FeishuAuth,
    file_key: &str,
) -> Result<Vec<u8>, ChannelError> {
    let token = auth.get_token().await?;
    let url = format!("{}/im/v1/files/{}", auth.api_base(), file_key);

    let res = auth
        .client()
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|err| ChannelError::Other(format!("Download file failed: {}", err)))?;

    if !res.status().is_success() {
        return Err(ChannelError::Other(format!(
            "Download file HTTP {}: {}",
            res.status(),
            file_key
        )));
    }

    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|err| ChannelError::Other(format!("Read file bytes failed: {}", err)))
}

/// Resolve `feishu:image:{key}` / `feishu:file:{key}` media references in an
/// InboundMessage to local file paths by downloading from Feishu API and
/// persisting to `~/.orgii/session-images/`.
pub(super) async fn resolve_feishu_media(
    auth: &FeishuAuth,
    media: &mut Vec<String>,
) {
    let images_dir = app_paths::session_images_dir();
    let _ = std::fs::create_dir_all(&images_dir);
    tracing::info!("[feishu:debug] resolve_feishu_media entered, media_count={}, dir={}", media.len(), images_dir.display());

    for entry in media.iter_mut() {
        if let Some(image_ref) = entry.strip_prefix("feishu:image:") {
            let image_ref = image_ref.to_string();
            let download_result = if let Some((message_id, image_key)) = image_ref.split_once(':') {
                download_message_image(auth, message_id, image_key).await
            } else {
                download_image(auth, &image_ref).await
            };
            match download_result {
                Ok(bytes) => {
                    let hash = sha256_hex(&bytes);
                    let ext = image_ext_from_bytes(&bytes);
                    let filename = format!("{}.{}", &hash[..16], ext);
                    let path = images_dir.join(&filename);
                    if !path.exists() {
                        if let Err(err) = std::fs::write(&path, &bytes) {
                            warn!("[feishu] Failed to persist image {}: {}", image_ref, err);
                            continue;
                        }
                    }
                    *entry = path.to_string_lossy().to_string();
                }
                Err(err) => {
                    warn!("[feishu] Failed to download image {}: {}", image_ref, err);
                }
            }
        } else if let Some(file_key) = entry.strip_prefix("feishu:file:") {
            let file_key = file_key.to_string();
            match download_file(auth, &file_key).await {
                Ok(bytes) => {
                    let hash = sha256_hex(&bytes);
                    let filename = format!("{}.bin", &hash[..16]);
                    let path = images_dir.join(&filename);
                    if !path.exists() {
                        if let Err(err) = std::fs::write(&path, &bytes) {
                            warn!("[feishu] Failed to persist file {}: {}", file_key, err);
                            continue;
                        }
                    }
                    *entry = path.to_string_lossy().to_string();
                }
                Err(err) => {
                    warn!("[feishu] Failed to download file {}: {}", file_key, err);
                }
            }
        }
    }
}

fn sha256_hex(data: &[u8]) -> String {
    crate::foundation::persistence::images::sha256_hex(data)
}

/// Upload an image to Feishu and return the image_key.
pub(super) async fn upload_image(
    auth: &FeishuAuth,
    file_path: &std::path::Path,
) -> Result<String, ChannelError> {
    let token = auth.get_token().await?;
    let url = format!("{}/im/v1/images", auth.api_base());

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.png")
        .to_string();

    let file_bytes = tokio::fs::read(file_path)
        .await
        .map_err(|err| ChannelError::Other(format!("Failed to read image file: {}", err)))?;

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(|err| ChannelError::Other(format!("Invalid MIME: {}", err)))?;

    let form = reqwest::multipart::Form::new()
        .text("image_type", "message")
        .part("image", part);

    let res = auth
        .client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::Other(format!("Invalid upload response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Upload failed");
        return Err(ChannelError::SendFailed(msg.to_string()));
    }

    json.get("data")
        .and_then(|d| d.get("image_key"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ChannelError::Other("Missing image_key in upload response".into()))
}

/// Upload a file to Feishu and return the file_key.
pub(super) async fn upload_file(
    auth: &FeishuAuth,
    file_path: &std::path::Path,
) -> Result<String, ChannelError> {
    let token = auth.get_token().await?;
    let url = format!("{}/im/v1/files", auth.api_base());

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let file_bytes = tokio::fs::read(file_path)
        .await
        .map_err(|err| ChannelError::Other(format!("Failed to read file: {}", err)))?;

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str("application/octet-stream")
        .map_err(|err| ChannelError::Other(format!("Invalid MIME: {}", err)))?;

    let form = reqwest::multipart::Form::new()
        .text("file_type", "stream")
        .text("file_name", file_name)
        .part("file", part);

    let res = auth
        .client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::Other(format!("Invalid upload response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Upload failed");
        return Err(ChannelError::SendFailed(msg.to_string()));
    }

    json.get("data")
        .and_then(|d| d.get("file_key"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ChannelError::Other("Missing file_key in upload response".into()))
}

/// Send a media message (image or file) to Feishu.
///
/// Uploads the local file first, then sends the message with the returned key.
pub(super) async fn send_media_message(
    auth: &FeishuAuth,
    chat_id: &str,
    file_path: &std::path::Path,
) -> Result<(), ChannelError> {
    let token = auth.get_token().await?;

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
    );

    let (msg_type, content_json) = if is_image {
        let image_key = upload_image(auth, file_path).await?;
        (
            "image",
            serde_json::json!({ "image_key": image_key }).to_string(),
        )
    } else {
        let file_key = upload_file(auth, file_path).await?;
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file");
        (
            "file",
            serde_json::json!({ "file_key": file_key, "file_name": file_name }).to_string(),
        )
    };

    let url = format!("{}/im/v1/messages?receive_id_type=chat_id", auth.api_base());
    let body = serde_json::json!({
        "receive_id": chat_id,
        "msg_type": msg_type,
        "content": content_json,
    });

    let res = auth
        .client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::SendFailed(format!("Invalid send response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let err_msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Media send failed");
        return Err(ChannelError::SendFailed(err_msg.to_string()));
    }

    Ok(())
}

// ── Message Lifecycle ───────────────────────────────────────────────────

/// Add an emoji reaction to a message (used as typing indicator).
pub(super) async fn add_reaction(
    auth: &FeishuAuth,
    message_id: &str,
    emoji_type: &str,
) -> Result<(), ChannelError> {
    let token = auth.get_token().await?;
    let url = format!(
        "{}/im/v1/messages/{}/reactions",
        auth.api_base(),
        message_id
    );

    let body = serde_json::json!({
        "reaction_type": {
            "emoji_type": emoji_type
        }
    });

    let res = auth
        .client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|err| ChannelError::Other(format!("Add reaction failed: {}", err)))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::Other(format!("Invalid reaction response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        warn!("[feishu] Add reaction failed (code {}): {}", code, msg);
    }

    Ok(())
}

/// Remove an emoji reaction from a message.
pub(super) async fn remove_reaction(
    auth: &FeishuAuth,
    message_id: &str,
    emoji_type: &str,
) -> Result<(), ChannelError> {
    let token = auth.get_token().await?;

    let list_url = format!(
        "{}/im/v1/messages/{}/reactions?reaction_type={}",
        auth.api_base(),
        message_id,
        emoji_type
    );

    let list_res = auth
        .client()
        .get(&list_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|err| ChannelError::Other(format!("List reactions failed: {}", err)))?;

    let list_json: Value = list_res
        .json()
        .await
        .map_err(|err| ChannelError::Other(format!("Invalid list response: {}", err)))?;

    if let Some(items) = list_json
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(|i| i.as_array())
    {
        for item in items {
            if let Some(reaction_id) = item.get("reaction_id").and_then(|r| r.as_str()) {
                let delete_url = format!(
                    "{}/im/v1/messages/{}/reactions/{}",
                    auth.api_base(),
                    message_id,
                    reaction_id
                );

                let _ = auth
                    .client()
                    .delete(&delete_url)
                    .header("Authorization", format!("Bearer {}", token))
                    .send()
                    .await;

                break;
            }
        }
    }

    Ok(())
}

/// Update (edit) a previously sent message.
pub(super) async fn update_feishu_message(
    auth: &FeishuAuth,
    message_id: &str,
    content: &str,
    render_mode: &str,
) -> Result<(), ChannelError> {
    let token = auth.get_token().await?;
    let url = format!("{}/im/v1/messages/{}", auth.api_base(), message_id);

    let use_card = should_use_card(content, render_mode);
    let (msg_type, content_json) = if use_card {
        ("interactive", build_card_content(content))
    } else {
        ("text", build_text_content(content))
    };

    let body = serde_json::json!({
        "msg_type": msg_type,
        "content": content_json,
    });

    let res = auth
        .client()
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::SendFailed(format!("Invalid update response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let err_msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Update failed");
        return Err(ChannelError::SendFailed(err_msg.to_string()));
    }

    Ok(())
}
