---
title: 'Quantiles, p99, and native histograms'
description: 'Classic histograms versus native histograms — how each represents a distribution, what histogram_quantile actually computes, and where the approximations break down.'
date: 2026-05-11
tags: ['observability', 'metrics', 'histograms', 'prometheus']
---

What a quantile actually is, why p99 is the number you care about, and how native histograms upgrade the classic histogram model.

## What's a quantile?

A quantile is a **cut point** in a sorted set of values. The **q-th quantile** is the value below which a fraction `q` of the data falls.

Suppose you measured 100 HTTP request latencies and sorted them:

```
Request:    #1   #2   #3   ...   #50   ...   #95   ...   #99   #100
Latency:   3ms  3ms  4ms        45ms        420ms       1.2s   8.7s
```

Then:
- **0.50 quantile** = 45ms — half the requests are below 45ms.
- **0.95 quantile** = 420ms — 95% are below 420ms; 5% are slower.
- **0.99 quantile** = 1.2s — 99% are below 1.2s; 1% are slower.
- **0.999 quantile** = somewhere in [1.2s, 8.7s] — 0.1% are slower.

The quantile **is the value at the cut point**, not the percentage itself. It answers *"what latency is X% of my traffic under?"*

## p99 is just shorthand

"p99" = "99th percentile" = 0.99 quantile. Same thing, different notation.

```
p50  = median            ← 50% of traffic is under this
p90  = 90th percentile   ← 10% is slower
p95  = 95th percentile   ← 5%  is slower
p99  = 99th percentile   ← 1%  is slower
p999 = 99.9th percentile ← 0.1% is slower (the "tail of the tail")
```

### Why p99 specifically

Means lie. Consider 5 request latencies: `[10ms, 10ms, 10ms, 10ms, 5000ms]`.

- **Mean:** 1008ms — sounds awful.
- **p50 (median):** 10ms — sounds great.
- **p80:** 10ms — still great.
- **p99:** 5000ms — *here's* the truth.

For user-facing latency, the *worst* requests are what matter. If your p50 is 50ms but your p99 is 5s, that's 1% of users (which could be tens of thousands) having a terrible experience. The mean hides this; p99 surfaces it.

The canonical SRE/SLO practice: **set objectives on p99 or p99.9, not on mean.**

---

## Native histograms

The [classic-histogram explainer](/posts/prometheus-metric-types/) only gave native histograms a few lines. They deserve more.

### The problem with classic histograms

A classic Prometheus histogram emits **N+2 series per metric**, where N is the bucket count:

```
http_duration_bucket{le="0.1"}     # series 1
http_duration_bucket{le="0.5"}     # series 2
http_duration_bucket{le="1.0"}     # series 3
http_duration_bucket{le="2.5"}     # series 4
...
http_duration_bucket{le="+Inf"}    # series N
http_duration_sum                  # series N+1
http_duration_count                # series N+2
```

For a 20-bucket histogram with 50 unique label sets, that's **22 × 50 = 1,100 series** for one logical metric. Cardinality explodes fast.

Worse, the **bucket boundaries are chosen at instrumentation time**. The operator picks them, often badly:
- Buckets too coarse → can't tell p99 from p50.
- Buckets too fine → cardinality blow-up.
- Buckets in the wrong range → all your data lands in one bucket and resolution is zero.

You cannot change buckets retroactively. The data is captured at whatever resolution your past-self picked.

### What native histograms change

Native histograms (Prometheus v2.40+, GA 2023) replace the N+2 series with **one series per metric+labels**, storing the entire histogram as a single binary blob in each sample.

```
http_duration{svc="api"}  →  { schema:2, buckets:[(boundary, count), ...] }
```

That's it. One series. One blob per sample. The blob contains every bucket's count, encoded in a compact format.

### How the buckets work

Native histograms use **exponential bucketing**. The bucket boundaries are powers of a fixed base:

```
boundary[k] = base^k     where   base = 2^(1/n)
```

`n` is the "schema" — controls resolution.

- **schema = 0:** base = 2.   Boundaries at 1, 2, 4, 8, 16, …  Coarse.
- **schema = 2:** base ≈ 1.19. Boundaries at 1, 1.19, 1.41, 1.68, 2.0, …  Fine.
- **schema = 8:** base ≈ 1.09. Boundaries at 1, 1.09, 1.18, 1.28, …  Very fine.

Each "octave" (factor of 2) is sliced into `2^n` buckets.

This gives **logarithmic resolution** — fine resolution where values are small, coarse where they're large. Which matches reality: a 5ms vs 10ms latency difference matters; a 5s vs 5.01s difference doesn't.

Compare to a classic histogram with manually-chosen buckets `[0.1, 0.5, 1.0, 2.5, 5.0]`: that's 5 buckets total. A schema-2 native histogram covering the same range gives you **~24 buckets** — five times the resolution, with zero extra cardinality.

### Buckets expand automatically

Classic histograms have fixed buckets — values outside the range fall into the catch-all `+Inf` bucket and lose resolution.

Native histograms **expand their bucket range dynamically**. If a new observation falls outside the seen range, the agent adds new buckets on the fly. You always get resolution wherever your data actually is.

### Mergability — the killer feature

Recall the classic histogram property: you can `sum by (le)` across pods to get a cluster-wide histogram, and quantiles computed from the merged buckets are mathematically valid.

Native histograms preserve this — and more: because every native histogram uses the same exponential scheme, two histograms can be merged in constant time without alignment. For each shared bucket index, add the counts.

This is fundamentally different from Summary (which can't be merged at all) and slightly better than classic histograms (which require all instances to use the same `le` boundaries to merge correctly).

### Trade-offs

| | Classic histogram | Native histogram |
|---|---|---|
| Series per metric | N+2 (often 12-25) | **1** |
| Bucket boundaries | Fixed at agent | Auto-scaled, exponential |
| Resolution | Whatever you guessed | Uniform log-scale |
| Auto-expand to new values | No (`+Inf` catches it) | Yes |
| Merging across instances | Yes (if boundaries match) | Yes (always works) |
| PromQL function support | Mature | Newer, still landing |
| Tool support outside Prometheus | Universal | Spotty |
| Storage size | One sample per bucket per scrape | One blob per scrape |
| Agent CPU | Cheaper | Slightly more (sketch update) |
| Wire format | Plain text or protobuf | Protobuf only |

### When to use which

- **New code, modern Prometheus stack:** native histograms. The cardinality reduction alone is worth it.
- **Legacy infra, mixed tooling:** classic histograms. Better-supported across the ecosystem.
- **You need a specific fixed bucket set for SLO accounting** (e.g. SLO defined as *"requests with latency ≤ 200ms"*): classic histograms — you can match the `le` to the SLO boundary exactly.

### Cousins

Native histograms are conceptually similar to:
- **DDSketch** (DataDog) — same exponential-bucket idea, slightly different math.
- **HdrHistogram** (Java ecosystem) — exponential bucketing with high-dynamic-range support.
- **t-digest** — uses centroids instead of buckets; different trade-offs.

Prometheus's native histogram is essentially the DDSketch idea folded into Prometheus's data model.

---

**One-line summary:** a quantile is the value at a sorted-data cut point; p99 is the 99th-percentile cut point and the canonical tail-latency metric; native histograms encode a whole histogram in one series using exponential buckets, fixing classic histograms' cardinality and bucket-choice problems at the cost of newer tooling support.
