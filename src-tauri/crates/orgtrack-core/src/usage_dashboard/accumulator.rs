//! [`UsageHeadlineAccumulator`]: incremental headline + trend aggregation
//! over a stream of [`UsageRoundRow`]s.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::rounds::UsageRoundRow;
use super::{cache_hit_rate, BucketSummary, TrendBucket, UsageSummary, UsageTrendPoint};

/// Incremental headline + trend aggregation. The dashboard used to build a
/// complete `Vec<UsageRoundRow>` and then fold it twice; keeping only session
/// ids, bucket ids, and time buckets makes headline memory proportional to the
/// number of sessions/buckets rather than the number of requests.
pub(super) struct UsageHeadlineAccumulator {
    summary: UsageSummary,
    per_bucket: BTreeMap<String, BucketSummary>,
    sessions_seen: HashSet<String>,
    bucket_sessions: HashMap<String, HashSet<String>>,
    trend_points: HashMap<i64, UsageTrendPoint>,
    trend_bucket: TrendBucket,
    collect_summary: bool,
    collect_trends: bool,
}

impl UsageHeadlineAccumulator {
    pub(super) fn new(
        trend_bucket: TrendBucket,
        collect_summary: bool,
        collect_trends: bool,
    ) -> Self {
        Self {
            summary: UsageSummary::default(),
            per_bucket: BTreeMap::new(),
            sessions_seen: HashSet::new(),
            bucket_sessions: HashMap::new(),
            trend_points: HashMap::new(),
            trend_bucket,
            collect_summary,
            collect_trends,
        }
    }

    pub(super) fn observe(&mut self, round: &UsageRoundRow) {
        if self.collect_summary {
            self.summary.request_count += 1;
            if !self.sessions_seen.contains(&round.session_id) {
                self.sessions_seen.insert(round.session_id.clone());
                self.summary.session_count += 1;
            }
            self.summary.input_tokens += round.input_tokens;
            self.summary.output_tokens += round.output_tokens;
            self.summary.cache_read_tokens += round.cache_read_tokens;
            self.summary.cache_write_tokens += round.cache_write_tokens;
            self.summary.cost_usd += round.cost_usd;

            let entry = self
                .per_bucket
                .entry(round.bucket.clone())
                .or_insert_with(|| BucketSummary {
                    bucket: round.bucket.clone(),
                    ..BucketSummary::default()
                });
            entry.real_total_tokens += round.real_total_tokens;
            entry.cost_usd += round.cost_usd;
            let bucket_sessions = self
                .bucket_sessions
                .entry(round.bucket.clone())
                .or_default();
            if !bucket_sessions.contains(&round.session_id) {
                bucket_sessions.insert(round.session_id.clone());
                entry.session_count += 1;
            }
        }

        if self.collect_trends && round.created_at_ms > 0 {
            let key = self.trend_bucket.floor(round.created_at_ms);
            let point = self
                .trend_points
                .entry(key)
                .or_insert_with(|| UsageTrendPoint {
                    bucket_ms: key,
                    ..UsageTrendPoint::default()
                });
            point.input_tokens += round.input_tokens;
            point.output_tokens += round.output_tokens;
            point.cache_write_tokens += round.cache_write_tokens;
            point.cache_read_tokens += round.cache_read_tokens;
            point.cost_usd += round.cost_usd;
        }
    }

    pub(super) fn finish(mut self) -> (UsageSummary, Vec<UsageTrendPoint>) {
        self.summary.real_total_tokens = self
            .summary
            .input_tokens
            .saturating_add(self.summary.output_tokens)
            .saturating_add(self.summary.cache_read_tokens)
            .saturating_add(self.summary.cache_write_tokens);
        self.summary.total_tokens = self.summary.real_total_tokens;
        // Rounds carry list-price estimates; recorded metered spend isn't
        // tracked per round, so the headline == estimated here.
        self.summary.estimated_cost_usd = self.summary.cost_usd;
        self.summary.cache_hit_rate = cache_hit_rate(
            self.summary.input_tokens,
            self.summary.cache_write_tokens,
            self.summary.cache_read_tokens,
        );
        self.summary.by_bucket = self.per_bucket.into_values().collect();

        let mut trends: Vec<UsageTrendPoint> = self.trend_points.into_values().collect();
        trends.sort_by_key(|point| point.bucket_ms);
        (self.summary, trends)
    }
}
