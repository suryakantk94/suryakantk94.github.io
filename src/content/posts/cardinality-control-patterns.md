---
title: 'Cardinality control in production metrics systems'
description: 'A field guide to the toolbox for taming high-cardinality metrics: dropping at scrape, sampling, rate-limiting, aggregation rules, and shaping pipelines — when each one applies and what they cost.'
date: 2026-05-11
tags: ['observability', 'metrics', 'cardinality', 'prometheus']
---

Why metric cardinality kills you, and the design patterns metrics systems use to reduce it without losing the metric.

## What is cardinality?

In a Prometheus-style metrics system, **cardinality** is the number of distinct time series. Each unique combination of `(metric_name, labels)` is its own series, stored independently.

Consider `http_requests_total` with these labels:

| Label | Distinct values |
|---|---|
| `method` | 5 (GET, POST, PUT, DELETE, PATCH) |
| `status` | 6 (200, 201, 400, 404, 500, 503) |
| `svc` | 10 services |
| `pod` | 10 pods per service |
| `user_id` | 1,000,000 |

Total cardinality: 5 × 6 × 10 × 10 × 1,000,000 = **3 billion series**.

Storage, indexing, and query cost scale roughly linearly with cardinality. At 3 billion series, the metric is unaffordable.

## Why labels explode

The killer pattern: a high-cardinality dimension gets added to a label set for "convenient debugging," then never removed.

Common offenders:
- `user_id`, `customer_id`, `session_id`
- `request_id`, `trace_id` (these should be in logs or traces, never metric labels)
- `path` with unbounded path components (e.g. `/users/{user_id}/orders`)
- Auto-generated IDs (UUIDs, timestamps)

Rule of thumb: any label whose distinct values can grow unbounded is a cardinality bomb.

## Pattern 1 — Drop the metric entirely

The blunt option. If a metric is too expensive, stop ingesting it.

- **Pros:** simple, immediate cost reduction.
- **Cons:** you lose all visibility into the underlying behaviour. Alerts and dashboards built on the metric stop working.

When to use: metrics that turned out to be redundant or never queried.

## Pattern 2 — Drop labels (e.g. Prometheus `labeldrop`)

Remove the high-cardinality label, keep the metric.

For **gauges**, this is safe-ish — the remaining samples are interpretable as point-in-time values across the broader scope, and aggregating them across instances is well-defined.

For **counters**, this is **mathematically unsafe**. When `labeldrop user_id` runs, the relabel pipeline ends up with multiple samples sharing the same label set but different counter values. They get treated as one series, but the values don't combine meaningfully:

- Pod A's counter is 100.
- Pod B's counter is 50.
- After `labeldrop`, both samples land at the same label set. The series sees `100, 50, 100, 50, …` — looks like a counter reset to PromQL, which kills the `rate()` computation.

Counters were never designed to be combined post-hoc. The math has to happen *before* the values are stored.

## Pattern 3 — Aggregate-then-drop at ingest

The correct answer for counters: aggregate across the dropped dimensions *before* the data is stored.

For each `(metric, kept_labels, window)` tuple, accumulate samples in memory; at window close, emit one aggregated row containing the pre-summed counters.

Conceptually equivalent to running a recording rule like:

```promql
sum without (user_id) (rate(http_requests_total[1m]))
```

— but evaluated at ingest time, so the high-cardinality data never lands in long-retention storage.

What columns to emit per metric type:

| Type | Emit |
|---|---|
| Counter | `sum`, `count`, `first`, `first_ts`, `last` — `first_ts` enables correct `rate()` across windows |
| Gauge | `min`, `max`, `sum`, `count`, `first`, `last` — multiple aggregations because you can't recover them later |
| Classic histogram | Preserve `le`, sum bucket counts (so `histogram_quantile` is still computable at query time) |
| Native histogram | Pass-through |
| Summary | Don't aggregate. Quantiles cannot be safely combined across series. |

## Pattern 4 — Retention tiering

Different metrics deserve different retention. A debug metric only useful for 24h shouldn't sit in 30-day storage.

Implementation usually has two layers:
- **Per-metric policy** — operator declares "metric X gets 7-day retention, metric Y gets 30-day."
- **Storage routing** — a tag on each sample (e.g. a header on the streaming bus) selects the partition/segment with the matching retention policy.

Combining with aggregation: keep the raw data for a short window (useful for ad-hoc debugging), and the aggregated rollup for long retention.

## Pattern 5 — Rollup tables for query speed

Independent of cardinality reduction, large time ranges benefit from pre-aggregated rollups.

If a dashboard asks `rate(metric[5m])` over a 7-day range with a 1-hour step, naively scanning raw samples is brutal. Storing pre-aggregated rows at 5-minute or 1-hour resolution lets the query layer scan ~10-100× fewer rows.

A typical rollup schema:

| Column | What |
|---|---|
| `name`, `labels` | the metric identity |
| `ts` | window-end timestamp |
| `resolution` | window length in seconds (60, 300, 3600, …) |
| `sum`, `count`, `min`, `max`, `first`, `first_ts`, `last`, `counter` | pre-aggregated values |
| `le`, `histogram` | histogram support |

The same series can exist at multiple resolutions — the query layer picks the coarsest one that satisfies the query step.

## Pattern 6 — Query-side rewriting

Aggregation only pays off if queries can transparently read from the pre-aggregated table.

Dashboards are written against the original metric name and shape. The query layer needs to:

1. Detect that the queried metric has a pre-aggregated version.
2. Verify the query doesn't reference any dropped labels (otherwise fall back to raw, or warn the user).
3. Rewrite the read to target the aggregated table.
4. Strip redundant operators (e.g. drop the inner `rate()` when the aggregated row already encodes per-window rate via `first_ts` / `last` / `counter`).

This is usually the hardest part of the system — PromQL is rich, and recognising "pre-aggregated equivalent of this expression exists" requires careful pattern matching.

## Pattern 7 — Migration safety: keep original for a window

When a customer adds a new aggregation rule, the rule's correctness has to be validated against existing dashboards. The typical migration pattern:

1. Customer adds the rule with a "keep original for 24h" (or 7d) flag.
2. Both raw and aggregated streams flow into storage.
3. Customer compares their dashboards against the aggregated view for a few days.
4. Once confident, they turn off "keep original" — raw samples drop out, cardinality reduction is realised.

Without this safety net, a rule that turns out to be wrong silently breaks dashboards for days before anyone notices.

## The risk that's worth naming

A label that's dropped from a metric is **silently gone** for any query that referenced it — including alerts.

Imagine a customer drops `user_id` to save cost. A week later, an alert that read `error_rate by user_id > 5%` silently returns zero. No errors are logged; the alert just goes quiet.

Robust cardinality-control UX needs to **scan dashboards and alerts at rule-creation time** and warn the operator about every query that touches the labels they're about to drop. This is the same class of risk as dropping a database column without searching for references first.

## Trade-offs at a glance

| Pattern | Cardinality reduction | Query correctness | Implementation cost |
|---|---|---|---|
| Drop the metric | Total | Loses metric | Trivial |
| `labeldrop` (gauges) | High | Safe | Low |
| `labeldrop` (counters) | High | **Mathematically wrong** | Low |
| Aggregate-then-drop | High | Safe | Medium-high |
| Retention tiering | Per-metric | Safe | Low |
| Rollup tables | Indirect (query speedup) | Safe | Medium |
| Query rewriting | Enables others | Hard to get right | High |
| Keep-original window | Migration safety | n/a | Low |

The combination that actually works in production: **aggregate-then-drop at ingest + retention tiering + rollup tables + query rewriting + keep-original migration window**. Each piece on its own is partial; together they cover the cardinality story end-to-end.
