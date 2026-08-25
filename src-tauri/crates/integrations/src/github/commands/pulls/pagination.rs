use serde_json::Value;

use super::super::super::client::GitHubClient;

const GITHUB_PAGE_SIZE: usize = 100;

fn paged_path(base_path: &str, page: usize) -> String {
    let separator = if base_path.contains('?') { '&' } else { '?' };
    format!("{base_path}{separator}per_page={GITHUB_PAGE_SIZE}&page={page}")
}

pub(super) async fn get_paginated_array(
    client: &GitHubClient,
    base_path: &str,
) -> Result<Vec<Value>, String> {
    let mut page = 1;
    let mut items = Vec::new();
    loop {
        let data = client.get_conditional(&paged_path(base_path, page)).await?;
        let page_items = data
            .as_array()
            .ok_or_else(|| format!("GitHub API returned non-array for {base_path}"))?;
        let page_len = page_items.len();
        items.extend(page_items.iter().cloned());
        if page_len < GITHUB_PAGE_SIZE {
            break;
        }
        page += 1;
    }
    Ok(items)
}

pub(super) async fn get_paginated_field_array(
    client: &GitHubClient,
    base_path: &str,
    field: &str,
) -> Result<Vec<Value>, String> {
    let mut page = 1;
    let mut items = Vec::new();
    loop {
        let data = client.get_conditional(&paged_path(base_path, page)).await?;
        let page_items = data[field].as_array().ok_or_else(|| {
            format!("GitHub API returned missing array field `{field}` for {base_path}")
        })?;
        let page_len = page_items.len();
        items.extend(page_items.iter().cloned());
        if page_len < GITHUB_PAGE_SIZE {
            break;
        }
        page += 1;
    }
    Ok(items)
}
