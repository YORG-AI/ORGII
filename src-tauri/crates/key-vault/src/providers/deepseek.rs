//! DeepSeek pay-as-you-go balance lookup.

use serde_json::Value;

use crate::providers::quota_http::get_bearer_json;
use crate::types::{QuotaBalance, QuotaInfo};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const QUOTA_SOURCE: &str = "deepseek_balance";
const PLAN_TYPE: &str = "Pay-as-you-go";

pub struct DeepSeekQuotaFetcher;

impl DeepSeekQuotaFetcher {
    pub fn new() -> Self {
        Self
    }

    /// Fetch the exact provider-reported balance with one HTTP GET.
    pub async fn fetch_quota(&self, api_key: &str) -> Result<QuotaInfo, String> {
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("DeepSeek account has no API key".to_string());
        }

        let body = get_bearer_json("DeepSeek", DEEPSEEK_BALANCE_URL, api_key)
            .await
            .map_err(|error| error.to_string())?;
        parse_deepseek_quota(&body)
    }
}

impl Default for DeepSeekQuotaFetcher {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_deepseek_quota(body: &Value) -> Result<QuotaInfo, String> {
    let rows = body
        .get("balance_infos")
        .and_then(Value::as_array)
        .ok_or_else(|| "DeepSeek quota HTTP 200 response has no balance_infos array".to_string())?;

    let balance = select_funded_balance(rows)
        .ok_or_else(|| "DeepSeek quota HTTP 200 response has no usable balance row".to_string())?;

    Ok(QuotaInfo {
        remaining_percentage: -1.0,
        plan_type: Some(PLAN_TYPE.to_string()),
        quota_source: Some(QUOTA_SOURCE.to_string()),
        balance: Some(balance),
        ..Default::default()
    })
}

fn select_funded_balance(rows: &[Value]) -> Option<QuotaBalance> {
    let mut balances = rows
        .iter()
        .filter_map(|row| {
            let amount = finite_number(row.get("total_balance")?)?;
            finite_number(row.get("topped_up_balance")?)?;
            let currency = row.get("currency")?.as_str()?.trim().to_ascii_uppercase();
            (!currency.is_empty()).then_some(QuotaBalance { amount, currency })
        })
        .collect::<Vec<_>>();

    balances.sort_by(|left, right| {
        right.amount.total_cmp(&left.amount).then_with(|| {
            match (left.currency.as_str(), right.currency.as_str()) {
                ("USD", "USD") => std::cmp::Ordering::Equal,
                ("USD", _) => std::cmp::Ordering::Less,
                (_, "USD") => std::cmp::Ordering::Greater,
                _ => left.currency.cmp(&right.currency),
            }
        })
    });

    balances
        .iter()
        .find(|balance| balance.amount > 0.0)
        .cloned()
        .or_else(|| {
            balances
                .iter()
                .find(|balance| balance.currency == "USD")
                .cloned()
        })
        .or_else(|| balances.into_iter().next())
}

fn finite_number(value: &Value) -> Option<f64> {
    let number = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    number.is_finite().then_some(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_exact_balance_and_unknown_percentage() {
        let quota = parse_deepseek_quota(&json!({
            "is_available": true,
            "balance_infos": [{
                "currency": "cny",
                "total_balance": "12.3456789",
                "granted_balance": "2.0",
                "topped_up_balance": "10.3456789"
            }]
        }))
        .unwrap();

        let balance = quota.balance.unwrap();
        assert_eq!(balance.amount, 12.3456789);
        assert_eq!(balance.currency, "CNY");
        assert_eq!(quota.remaining_percentage, -1.0);
        assert!(quota.usage_items.is_empty());
        assert!(!quota.is_unlimited);
    }

    #[test]
    fn funded_row_wins_and_usd_breaks_equal_amount_tie() {
        let quota = parse_deepseek_quota(&json!({
            "balance_infos": [
                {"currency": "EUR", "total_balance": "5", "topped_up_balance": "1"},
                {"currency": "USD", "total_balance": 5.0, "topped_up_balance": 1.0},
                {"currency": "CNY", "total_balance": "0", "topped_up_balance": "0"}
            ]
        }))
        .unwrap();

        assert_eq!(quota.balance.unwrap().currency, "USD");
    }

    #[test]
    fn rejects_missing_or_non_numeric_balance_rows() {
        let error = parse_deepseek_quota(&json!({
            "balance_infos": [{"currency": "USD", "total_balance": "unknown"}]
        }))
        .unwrap_err();
        assert!(error.contains("HTTP 200"));
        assert!(error.contains("no usable balance row"));
    }
}
