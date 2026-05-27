---
title: 'Pre-aggregating metrics at ingest with rule-based shaping'
description: 'An end-to-end walkthrough of rule-based metric shaping: how the ingest path forks, how recording rules synthesise aggregations, and how the query side routes back to the right table.'
date: 2026-05-22
tags: ['observability', 'metrics', 'cardinality', 'recording-rules', 'promql']
---

> A pattern for taming high-cardinality metrics without dropping data: divert the
> raw series to a separate storage path, pre-aggregate them with recording
> rules, and serve queries from the aggregated view by default.

This post is a companion to [Cardinality control patterns](/posts/cardinality-control-patterns/). That one defines the problem and surveys the toolbox; this one zooms in on **one implementation pattern in depth** — the one you reach for when you have a noisy, high-cardinality metric you don't want to drop. We will follow it end-to-end: how data flows through the ingester, how the storage path forks, how recording rules synthesise the aggregations, and how the query side routes back to the right place.

The pattern is generic — nothing here depends on a specific vendor. If you have Prometheus-style scraping, a write path through Kafka (or similar), and a columnar metrics store, the shape applies.

---

## The setup: a metric you can't afford to keep, can't afford to lose

Imagine an HTTP server emitting `http_requests_total` with a `request_id` label. Every request creates a new series. Within an hour you have millions of series, the index struggles, queries slow down, the cost-per-metric chart trends up and to the right.

The textbook answers:

1. **Drop the label at scrape time.** Cheapest, but you lose the ability to ever drill down.
2. **Drop the metric entirely.** Even worse — no visibility at all.
3. **Keep it.** Pay the cost. Some teams choose this until the bill makes the choice for them.

There's a fourth answer that gets less coverage:

4. **Divert and aggregate at ingest.** Send the high-cardinality series to a *separate* storage path that the default query plane doesn't read. Synthesise low-cardinality aggregations from it via recording rules. Queries hit the aggregated view by default; the raw data is still there if you need to drill into it.

This is "rule-based metric shaping." It costs an extra storage table, an extra Kafka topic, a rule manager, and some plumbing. In return: the cardinality stays bounded for the hot path, the operator never lost the raw data, and the aggregations are computed once at ingest instead of per query.

The rest of this post walks through how that machinery looks.

---

## The bird's-eye view

```
                  +-----------------+
                  | scrape / OTLP   |
                  +--------+--------+
                           |
                           v
                  +-----------------+
                  |    INGESTER     |
                  |                 |
                  |  shaping rules  |  <-- config service: "for metric X,
                  |   (per-metric)  |       keep aggregated under name Y,
                  +--------+--------+       drop raw if keep_original=false"
                           |
            +--------------+---------------+
            |                              |
            | keep_original=true           | keep_original=false
            |                              |
            v                              v
   +----------------+              +----------------+
   |  main topic    |              |  staging topic |
   |  (kafka)       |              |  (kafka)       |
   +-------+--------+              +-------+--------+
           |                               |
           v                               v
   +----------------+              +----------------+
   |  main table    |              | staging table  |
   |  (columnar)    |              |   (columnar)   |
   +-------+--------+              +-------+--------+
           |                               |
           |  default queries              |  recording rules ONLY
           |  read here                    |  read here
           v                               v
       +---------+                  +-------------+
       |  query  |                  | rule manager|
       +---------+                  +------+------+
                                           |
                                           |  writes aggregated
                                           |  series back to
                                           |  the main table
                                           v
                                    +-------------+
                                    |  main table |
                                    +-------------+
```

Two things to notice:

- **The fork is at ingest, not at scrape.** Scraping continues to emit the full-fidelity metric. The split happens after a `shaping_rules` lookup keyed on metric name. That keeps the scraper dumb and centralizes the policy.
- **The recording rule is the only thing that reads the staging table by default.** End-user queries don't see it. The aggregated series the rule writes back to the main table is what the world sees.

The keep_original flag is the policy switch. `keep_original=true` says "leave the raw metric in the main table AND also synthesise an aggregation." `keep_original=false` says "the raw metric is too expensive — only the aggregation should be visible to default queries." Same machinery, different verdict on whether the raw still has a seat at the table.

> An aside on product surface area: both modes are useful design points, but a UI that exposes both as user-facing radio buttons creates a footgun — picking `keep_original=true` looks safer but quietly doubles your storage and undoes the whole point of shaping for high-cardinality metrics. Shipping the destructive mode (`keep_original=false`) as the only user-visible option, with the additive mode available only as a configdb override for power users, is a reasonable first-version stance. Anything driven primarily by storage cost should default to "do the thing the user came here to do" rather than "leave both copies around just in case."

---

## The shaping rule shape

A shaping rule is a small piece of configuration the operator writes:

```yaml
- source_metric_name:      http_requests_total
  destination_metric_name: http_requests:rate5m
  source_metric_type:      COUNTER
  aggregations:            [SUM]
  labels:                  [status, route]   # group by these
  label_operation:         BY                # BY or WITHOUT
  evaluation_interval:     1m
  keep_original:           false             # divert
```

What this says: every minute, sum `rate(http_requests_total[5m])` over the `status` and `route` labels, and write the result back under the name `http_requests:rate5m`. The raw `http_requests_total` series, which used to explode by `request_id`, are diverted to the staging table where they're still queryable for forensics but invisible to the default dashboards.

For percentile-style aggregations on histograms, the rule expands into a `histogram_quantile` expression:

```yaml
- source_metric_name:      request_duration_bucket
  destination_metric_name: request_duration:p95
  source_metric_type:      CLASSIC_HISTOGRAM
  aggregations:            [P95]
  labels:                  [service]
  label_operation:         BY
  evaluation_interval:     1m
  keep_original:           false
```

Synthesised expression:

```promql
histogram_quantile(0.95, sum by(le, service) (rate(request_duration_bucket[5m])))
```

A few choices worth calling out:

- **`le` is always preserved on classic histograms — under both `BY` and `WITHOUT`.** Classic histograms encode bucket boundaries in the `le` label. Drop it from the inner sum and `histogram_quantile` has nothing to operate on. The synthesiser is paranoid about this in two complementary ways: in `BY` mode it prepends `le` to the keep list; in `WITHOUT` mode it silently filters `le` out of the drop list so the user can't accidentally drop it. Either way the inner aggregation keeps `le`.
- **The rate window scales with the evaluation interval.** A rule that evaluates every hour shouldn't use a 5-minute window — one bucket is too few. The synthesiser uses `max(5m, 4 × interval)` so a 1h rule gets `[4h]` automatically.

### The validation matrix

The rule synthesiser doesn't accept every combination of source type × aggregation × label operation. Some are rejected outright, some are rewritten to a safe form, and some pass through unchanged. The full matrix:

| Source type | Aggregation | `BY` | `WITHOUT` | What the synthesiser does |
|---|---|---|---|---|
| Counter | `SUM` | ✅ | ✅ | `sum by/without (…) (metric{})`. Output is still a cumulative counter per kept-label combo. |
| Counter | `AVG` / `MIN` / `MAX` / `COUNT` | ✅ | ✅ | Standard PromQL aggregation. Output is a gauge — the cumulative-counter shape is lost (averaging cumulatives doesn't produce a cumulative). |
| Gauge | `SUM` / `AVG` / `MIN` / `MAX` / `COUNT` | ✅ | ✅ | Standard PromQL aggregation. Output is a gauge. |
| Classic histogram (`_bucket`) | `SUM` | ✅ — `le` auto-prepended | ❌ rejected | Only `SUM` preserves histogram shape across instances. `BY` is required so `le` survives; `WITHOUT` is too easy to misuse (could silently drop `le` even with the filter — see note below) so it's blocked at validation time. |
| Classic histogram | `P50` / `P90` / `P95` / `P99` | ✅ — `le` auto-prepended | ✅ — `le` filtered out of drop list | Expands into `histogram_quantile(q, sum by/without (…le…) (rate(metric{}[window])))`. The synthesiser ensures `le` is in the inner sum regardless of which operation the user picked. |
| Classic histogram | `AVG` / `MIN` / `MAX` / `COUNT` | ❌ | ❌ | These don't preserve histogram-counter semantics. Rejected. |
| Native histogram | `SUM` / `AVG` / `MIN` / `MAX` / `COUNT` | ❌ | ❌ | Native histograms encode bucket data inside the sample, not as `le` labels. PromQL aggregations on a native histogram are well-defined but produce a *summed* native histogram — useful but not what shaping rules are for. Rejected. |
| Native histogram | `P50` / `P90` / `P95` / `P99` | ✅ | ✅ | Expands into `histogram_quantile(q, sum by/without (…) (rate(metric{}[window])))`. No `le` to protect — the bucket data rides inside the sample, so the user's grouping is left untouched. |

The asymmetry between `SUM` and percentile aggregations on classic histograms is worth lingering on. For `SUM` the synthesiser rejects `WITHOUT` because the recorded counter has to remain a usable histogram for downstream `histogram_quantile()` — `BY(le, …)` is the only way to be confident the output is still bucket-shaped. For percentile aggregations the `histogram_quantile()` happens *inside* the rule, so the synthesiser only needs to guarantee `le` is in the inner sum — which it can do equally well with `BY` (prepend) or `WITHOUT` (filter out of drop list). The user gets more flexibility on percentile rules without losing the safety property.

---

## The recording rule pipeline

Once a shaping rule lands in the config table, the rule manager picks it up:

```
config table                         rule manager
                                          |
  shaping_rules                           |  poll every 30s
  +---------------+                       |  (atomic snapshot)
  | id | name | … | ------ snapshot ----> |
  +---------------+                       |
                                          v
                                +-------------------+
                                |  YAML synthesiser |
                                |                   |
                                |  one rule per row |
                                |  one group per    |
                                |  (table, folder,  |
                                |   interval)       |
                                +---------+---------+
                                          |
                                          v
                                +-------------------+
                                |  rule eval loop   |
                                |  (Prometheus-     |
                                |   compatible)     |
                                +---------+---------+
                                          |
                                          v
                                  +-------------+
                                  | remote write|
                                  |  to main    |
                                  |  table      |
                                  +-------------+
```

The polling is intentionally generic: the same machinery serves *any* rule source — derived metrics, alerts, future config-backed rule types. The synthesiser plugs in domain-specific YAML emitters; everything downstream (the atomic snapshot, the last-known-good fallback on render error, the merge with file-based rules) is shared.

**Last-known-good is the key resilience property.** Configs change. Operators add a rule with a typo. Without last-known-good, every refresh that hits a parse error would strip the entire source's rules from the running manager. Instead: parse each rule's expression independently, skip the bad one with a log line, keep the rest. The merged groups map preserves whatever was last successfully loaded for sources that fail to refresh.

```
                                +-------------------+
                                | refresh tick      |
                                +---------+---------+
                                          |
       +----------------------------------+-----+
       |                                        |
       v                                        v
  file rules                            configdb rules
  (always reloaded)                    (per-source try)
                                                |
                                       +--------+---------+
                                       |                  |
                                       v                  v
                                   success          render or load fails
                                       |                  |
                                       |          fall back to last-good
                                       |                  |
                                       +--------+---------+
                                                |
                                                v
                                       merged groups map
                                                |
                                                v
                                       UpdateWithGroups()
```

Two things this gives you: (1) a single source failing doesn't take down the others, and (2) a flaky config table doesn't strip already-loaded rules. The system degrades gracefully toward "running on yesterday's config" rather than "running on nothing."

---

## Query-side routing: the part most posts skip

Synthesising the rule is half the problem. The other half: the rule needs to *read from the staging table*, not the main one. The query engine has no idea where to read from — it just sees a PromQL expression.

There are two reasonable ways to convey "read from staging" through to the storage layer:

**Option A: magic label matcher.** Stamp a label into the synthesised PromQL: `{__name__="http_requests_total", __source_table__="staging"}`. The adapter strips the label before SQL generation and uses its value to pick the table.

```
rule manager     ── synthesises PromQL with magic label ──→     adapter
                                                                strips label,
                                                                routes to staging
```

This works but is fragile. You're depending on Prometheus to pass an undocumented label through `Querier.Select(...)` unchanged. A future change in the rules engine that canonicalises label sets or filters internal labels could silently break it. You also leak the convention into anything that ever logs or inspects the matchers slice.

**Option B: out-of-band routing via context.** Don't put the table choice in the PromQL at all. Encode it where the rule manager owns the channel: the **rule group name**. Then at evaluation time, parse the group name, set the table on the request context, and have the adapter read it from context.

```
rule manager
  │
  │  group name: "metric_shaping:staging:<folder>:<interval>"
  │
  v
prom rules engine
  │  QueryFunc(ctx, qs, ts):
  │    groupName := ctx.Value(QueryOrigin)
  │    if shaping group → ctx = WithSourceTable(ctx, "staging")
  │
  v
adapter
  │  createQueryInfo(ctx):
  │    if SourceTableOverride(ctx) != "" → use it
  │
  v
columnar store → staging table
```

The synthesised PromQL stays clean (`sum by(status) (http_requests_total{})`). The routing signal travels alongside the query through a channel both sides agree on — context. It's an honest contract between two pieces of code in the same binary, rather than a label that has to survive a tour through an external library.

A subtle but real benefit: **the rule manager's evaluation context already exposes the group name to the query function** via `promql.QueryOrigin`. So Option B doesn't require patching the Prometheus fork or threading a new field through any boundary. The hook already exists.

---

## What rolls back when things go wrong

Three failure modes are worth designing for:

**1. The config table is unreachable.** The poller's last-known-good snapshot still serves reads. The rule manager keeps evaluating the rules from the previous successful poll. The synthesiser doesn't care.

**2. A single rule has an unparseable expression.** Per-rule `parser.ParseExpr` at synthesis time catches it. The bad rule is logged and skipped; every other rule in the same source ships normally. This is the difference between "the YAML had a typo somewhere" and "the YAML had a typo and now no rules are loaded."

**3. The synthesiser produces YAML that the rules engine can't load.** The new groups map fails to land. The per-source last-known-good fallback preserves the previously-loaded groups so the running manager doesn't go silent. The operator sees the failure in logs and fixes the config; the rules keep running on the old config until then.

What you specifically want to *avoid*: a single bad rule causing the entire source's rules to disappear. That happens when the load is treated as all-or-nothing. The fix is per-rule validation + per-source last-known-good — both cheap, both load-bearing.

---

## What this pattern is not

Worth being explicit about the boundaries:

- **It's not a substitute for dropping labels.** If a label has truly unbounded cardinality (raw request IDs, user IDs), the right move is still to drop it at scrape time. Shaping is for metrics that are *useful* high-cardinality — where the raw values matter for forensics but the aggregations are what the operator wants on dashboards.
- **It's not free.** You're paying for an extra Kafka topic, an extra storage table, a rule manager goroutine, and the synthesis pipeline. The savings only kick in when the cardinality of the source metric is large enough that the aggregation reduces the working set by an order of magnitude or more.
- **It's not a query-time tool.** The aggregations are computed at evaluation time, on a fixed cadence, and stored as new series. Ad-hoc queries that need exotic groupings still hit the raw table — that's why diverting (rather than dropping) the raw matters.
- **It's not symmetric across histogram flavours.** Classic histograms (a counter per `le` bucket) and native histograms (bucket data inside the sample) need different machinery. Classic supports `SUM` (preserves bucket shape, with `le` auto-protected) and percentile aggregations. Native rejects `SUM`/`AVG`/`MIN`/`MAX` outright — there's no `le` to fold over, and the aggregation modes that *are* well-defined on natives don't fit the shaping use case — and only supports percentile aggregations via `histogram_quantile`. The matrix above spells out exactly which combinations the synthesiser accepts.

The mental model is: **shape the hot path, keep the cold path queryable**. Default dashboards and alerts hit the aggregations. Incident drill-downs can still get to the raw data when they need to.

---

## What I'd build first if starting from scratch

In order of leverage:

1. **The config table + a single-source poller.** Atomic snapshot, last-known-good, periodic refresh. This is the foundation everything else plugs into.
2. **A YAML synthesiser for one aggregation type (sum).** Get the rule-group bucketing by (table, folder, interval) right; the rest of the shapes (avg, max, percentile) layer on cleanly.
3. **Group-name encoded routing.** Skip the magic-label detour; pay the small upfront cost of parsing the group name and setting context.
4. **Per-rule validation with `parser.ParseExpr`.** This is the difference between "one bad rule" and "all rules gone" failure modes.
5. **Last-known-good at the rule-source level.** Belt-and-suspenders on top of per-rule validation; covers cases where the rules-engine load itself fails.

The histogram support (classic vs native, `le` preservation, `BY`-only on percentiles) comes later — get the core SUM path right first.

---
