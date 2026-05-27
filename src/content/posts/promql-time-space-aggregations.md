---
title: 'PromQL time and space aggregations — a visual intuition'
description: 'Why some PromQL functions collapse the time axis and others collapse the label axis, and how mixing the two changes what your dashboard actually shows.'
date: 2026-05-11
tags: ['observability', 'promql', 'prometheus']
---

The intuition that "time" and "space" mean two different collapse directions in PromQL.

## Setup

`http_requests_total` is a counter scraped every 30s from 3 pods. Over 2 minutes:

```
                          TIME →
                  t=0    t=30s   t=60s   t=90s   t=120s
        ┌─────┐
SERIES  │pod-1│   10      22      30      45      50
   ↓    │pod-2│    5      15      20      30      40
        │pod-3│    8      12      25      35      42
        └─────┘
```

Three series, five samples each. Total: 15 numbers. The cumulative counters go up.

## Time aggregation — collapses *along a row*

**`rate(http_requests_total[2m])`** — for each series, look at samples within a 2-minute range vector and compute one number.

```
                          TIME →
                  t=0    t=30s   t=60s   t=90s   t=120s
        ┌─────┐
        │pod-1│   10 ━━━━━━━━━━ rate over [2m] ━━━━━━━ 50   →  (50−10)/120 = 0.33 /s
SERIES  │pod-2│    5 ━━━━━━━━━━ rate over [2m] ━━━━━━━ 40   →  (40−5)/120  = 0.29 /s
        │pod-3│    8 ━━━━━━━━━━ rate over [2m] ━━━━━━━ 42   →  (42−8)/120  = 0.28 /s
        └─────┘
                  └──────────── one window ───────────┘
```

Result: **3 series × 5 samples → 3 series × 1 value**. The time axis is gone.

Other time aggregators: `increase`, `sum_over_time`, `avg_over_time`, `max_over_time`, `delta`…

## Space aggregation — collapses *down a column*

**`sum(http_requests_total)`** — at each timestamp, sum across all series.

```
                          TIME →
                  t=0    t=30s   t=60s   t=90s   t=120s
        ┌─────┐
        │pod-1│   10      22      30      45      50
SERIES  │pod-2│    5      15      20      30      40
   ↓    │pod-3│    8      12      25      35      42
        └──┬──┘   ┆       ┆       ┆       ┆       ┆
           ▼      ▼       ▼       ▼       ▼       ▼
       sum(...)  23      49      75     110     132
```

Result: **3 series × 5 samples → 1 series × 5 samples**. The series dimension is gone (or reduced — see `by`/`without` below).

Other space aggregators: `avg`, `min`, `max`, `count`, `topk`, `quantile`…

### Variant: keep some dimensions

`sum by (region) (http_requests_total)` collapses across pods but keeps `region`. If pod-1+pod-2 are in `us` and pod-3 is in `eu`:

```
                  t=0    t=30s   t=60s   t=90s   t=120s
  region=us       15      37      50      75      90    ← pod-1 + pod-2
  region=eu        8      12      25      35      42    ← pod-3 alone
```

3 series → 2 series. "Collapse across the dimensions you don't list."

## Combined — the canonical PromQL pattern

**`sum(rate(http_requests_total[2m]))`** — time first, then space.

```
Step 1: rate per series (time aggregation)
        pod-1 → 0.33 /s
        pod-2 → 0.29 /s
        pod-3 → 0.28 /s

Step 2: sum across series (space aggregation)
        0.33 + 0.29 + 0.28 = 0.90 /s   ← cluster-wide request rate
```

**3 series × 5 samples = 15 numbers → 1 number.** That's the whole reason the pattern is `sum(rate(...))`: each half does the half the other can't.

## How this maps to a histogram

A histogram has an extra dimension: the bucket label `le`. So instead of 3 series there's 3 pods × 3 buckets = **9 series**:

```
                          TIME →
                            t=0    …    t=120s
  pod-1, le=0.1               5            22
  pod-1, le=0.5               8            42
  pod-1, le=1.0              10            50
  pod-2, le=0.1               2            17
  pod-2, le=0.5               4            30
  pod-2, le=1.0               5            40
  pod-3, le=0.1               3            18
  pod-3, le=0.5               6            30
  pod-3, le=1.0               8            42
```

The canonical p99 query:

```promql
histogram_quantile(0.99,
  sum by (le) (                              ← space agg: collapse pods, keep le
    rate(http_request_duration_bucket[2m])   ← time agg: rate per series
  )
)
```

1. **Time agg** — 9 series × 5 samples → 9 rates (one per series).
2. **Space agg `by (le)`** — 9 rates → **3 rates** (one per `le` bucket, summed across pods).
3. **`histogram_quantile(0.99, …)`** — given 3 bucket-rates, interpolate the 99th percentile.

The `by (le)` is what makes the histogram math valid — you must keep `le` to feed `histogram_quantile`.

---

**One-line summary:** time aggregation collapses samples *within* a series (across timestamps); space aggregation collapses *across* series (at one timestamp). The canonical PromQL pattern `sum(rate(...))` does both because each half does what the other can't.
