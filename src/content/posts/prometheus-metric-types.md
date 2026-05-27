---
title: 'The four Prometheus metric types'
description: 'Counter, gauge, histogram, summary — what each one stores, what PromQL is willing to do with it, and which questions each type answers cleanly.'
date: 2026-05-11
tags: ['observability', 'metrics', 'prometheus', 'promql']
---

The four classic metric types in Prometheus, with concrete wire-format examples and notes on when to use each.

## 1 · Counter

**What:** a value that only goes up (or resets to 0 when the process restarts). Never goes down.

**Wire format:** one series per unique label set.

```
http_requests_total{method="GET",  status="200", svc="api"}   1234
http_requests_total{method="POST", status="201", svc="api"}    567
http_requests_total{method="GET",  status="500", svc="api"}     12
```

**Real-world:** request counts, error counts, bytes sent, garbage-collection cycles.

**Querying:** the raw number is rarely interesting — you almost always wrap it in `rate()` or `increase()`:

```promql
rate(http_requests_total[5m])      # requests per second
increase(http_requests_total[1h])  # total in the last hour
```

**Why monotonic matters:** `rate()` assumes the series only goes up. If it drops, PromQL interprets that as a counter reset (process restart) and discards the negative delta. Counters that decrement break this and produce silent underestimates.

---

## 2 · Gauge

**What:** a value that can move up *or* down arbitrarily. Represents a point-in-time measurement.

**Wire format:**

```
memory_usage_bytes{pod="api-7f8d"}     8721536
goroutines_active{svc="api"}              142
queue_depth{queue="orders"}               873
temperature_celsius{rack="r4"}            21.5
```

**Real-world:** memory, CPU, disk free, queue depth, in-flight requests, current temperature — anything that answers *"what's it RIGHT NOW?"*

**Querying:** read directly, no `rate()`:

```promql
memory_usage_bytes                        # current value
max_over_time(memory_usage_bytes[1h])     # peak in the last hour
avg_over_time(memory_usage_bytes[5m])     # 5-min average
```

`*_over_time` functions are the typical time-aggregators for gauges. Never use `rate()` on a gauge — it returns nonsense.

---

## 3 · Histogram (classic)

**What:** captures observations into a configurable set of buckets, plus the total sum and count. **Emitted as many series per logical metric.**

**Wire format:** for an HTTP latency histogram with buckets `[0.1, 0.5, 1.0, +Inf]`:

```
http_duration_bucket{le="0.1",  svc="api"}    423   ← count of observations ≤ 100ms
http_duration_bucket{le="0.5",  svc="api"}    891   ← cumulative ≤ 500ms
http_duration_bucket{le="1.0",  svc="api"}    942   ← cumulative ≤ 1s
http_duration_bucket{le="+Inf", svc="api"}    950   ← total observations
http_duration_sum{svc="api"}                  178.4 ← total latency observed
http_duration_count{svc="api"}                950   ← same as +Inf bucket
```

So ONE logical metric → N+2 series, where N is the bucket count. Each bucket is itself a **counter** (always going up).

**Real-world:** request latency, response size, queue wait time — anything where you care about the distribution, not just the average.

**Querying:** `histogram_quantile` walks the buckets and linearly interpolates:

```promql
histogram_quantile(0.99,
  sum by (le) (
    rate(http_duration_bucket[5m])
  )
)
```

**The whole point of classic histograms:** quantiles are computed **at query time** from the bucket counts. This means you can `sum by (le)` across pods, services, regions — and the resulting cluster-wide histogram is still mathematically valid. (This is why histograms beat summaries; see #4.)

**Tradeoff:** bucket boundaries are **fixed at the agent**. If your buckets are `[0.1, 0.5, 1.0]` but 95% of your requests take either 5ms or 1500ms, you have no resolution where it matters and can't fix it retroactively.

---

## 4 · Summary

**What:** like histogram, but quantiles are computed at the **client** (agent) side, not at query time.

**Wire format:**

```
http_duration{quantile="0.5",  svc="api"}    0.123   ← p50 computed by the agent
http_duration{quantile="0.95", svc="api"}    0.847
http_duration{quantile="0.99", svc="api"}    1.532
http_duration_sum{svc="api"}                 178.4
http_duration_count{svc="api"}               950
```

The agent maintains a sliding window of samples in-process and computes the quantile internally.

**Pros:**
- Cheap to query (just read the number).
- No bucket-boundary problem — quantiles are computed from raw samples.

**Cons (and why histograms have largely won):**
- 🔴 **Cannot be aggregated across series.** You CANNOT take p99 from pod-1 and p99 from pod-2 and average them into a cluster p99. There is **no mathematically valid way** to combine quantiles after the fact. This is the killer flaw.
- The quantile set is fixed at the agent (`[0.5, 0.95, 0.99]` — want p99.9? too bad).
- More work on the agent side.

**Real-world:** legacy / specific cases. **New code should prefer histograms** unless you have a very good reason.

---

## Bonus · Native histograms

Newer Prometheus addition (~2023). A *single* series per metric+labels — buckets are auto-chosen by the agent using exponential bucketing.

| | Classic histogram | Native histogram |
|---|---|---|
| Series per metric | N+2 (high cardinality) | 1 |
| Bucket choice | Fixed at agent | Auto-scaled |
| PromQL support | Mature | Newer, some functions still landing |
| Storage | One row per bucket | One row per series |

---

## Side-by-side

| Type | Direction | Series per metric | Aggregatable across series? |
|---|---|---|---|
| Counter | up only | 1 | ✅ yes |
| Gauge | up & down | 1 | ✅ (with care) |
| Histogram (classic) | bucket counts ↑ | N+2 | ✅ YES — that's the design goal |
| Summary | quantile snapshots | M+2 | ❌ NO |
| Native histogram | bucket counts ↑ | 1 | ✅ yes |

---

## Decision tree: which type should you emit?

```
Does the value only go up?
├── yes → Counter
└── no
    │
    Is it a single number "right now"?
    ├── yes → Gauge
    └── no (it's a distribution)
        │
        Do you need percentiles aggregated across instances?
        ├── yes → Histogram
        │   ├── Need fixed, known buckets? → Classic
        │   └── Want auto-scaled, low-cardinality? → Native
        └── no → Summary (or just use a Histogram anyway)
```
