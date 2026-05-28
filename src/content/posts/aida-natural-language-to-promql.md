---
title: 'AIDA: building a natural-language → PromQL interface in 2023'
description: 'A retrospective on the prototype I built at Kloudfuse a year before "RAG" was a household term — natural-language questions in, PromQL out, three LLM backends in parallel. What worked, what burned, and what now feels obvious.'
date: 2023-07-03
tags: ['llm', 'rag', 'promql', 'observability', 'retrospective']
---

This is a retrospective on **AIDA** — a prototype Natural Language Interface for the Kloudfuse metrics product, built across June–July 2023. Written in 2026 looking back at notes from the time.

The job AIDA tried to do: take a question in plain English (*"Return the pod restarts by namespace"*) and emit a PromQL query against the customer's Kloudfuse cluster. Three years later that pattern has a name (RAG), a thousand reference architectures, and a shelf of frameworks. In mid-2023 it had none of those. Picking the model was harder than building the service.

## The architecture

The shape AIDA settled on, copied straight from the design doc:

![AIDA concept map: user question goes through similarity search against a vector DB to build context, then fans out to three LLM backends — BARD (Palm API), gpt4all running locally, and BARD-with-ThirdAI for retrieval — and a single response is shown in the UI.](/images/aida/concept-map.png)

The flow is one most readers will recognise immediately in 2026:

1. **Build a context corpus.** Take the customer's metric names, plus a manually curated PromQL training set, split, embed, write to a vector database.
2. **On each query**, run a similarity search to fetch the K most relevant rows of the training set as *context*.
3. **Compose a prompt** — `{question} + {retrieved context}` — and send it to the LLM.
4. **Three backends running in parallel**: BARD (Palm API), gpt4all running locally on the cluster, and a BARD + ThirdAI variant where ThirdAI's retrieval step replaced the vector DB.
5. **Return the generated PromQL** to the React frontend.

That's RAG. We just didn't have the word for it yet. The 2023 design doc calls it "providing context similar to the asked question with every query" — but the rest of the pipeline is identical to what every "build a chatbot over your docs" tutorial ships today.

## Models we tried and why

The notes from June 2023 list nine candidate models. The scorecard from the time:

| Model | Without context | With Kloudfuse training data | What killed it |
|---|---|---|---|
| **GPT-3.5-turbo** (OpenAI) | 4/5 accuracy, 5–10s | 5/5 | The API charges. Production deploy meant either renting OpenAI capacity per query forever or finding an alternative. |
| **BARD / PaLM** (Google) | 4/5, ~5s | 5/5 (with KF training) | Best balance of accuracy + cost — became the production path. Needed careful prompt engineering. |
| **BARD + ThirdAI retrieval** | — | 0/5 generative | ThirdAI's UDT did similarity search well but had no generative head. Combining it with BARD worked but added a hop. |
| **gpt4all-j** (LangChain, local) | 3/5, 25–60s | 1/5 | Crashed after ~10 queries — kept accumulating context and OOMing. Serialised across users (no parallelism). |
| **Alpaca-LoRA-7b** | 0/5 without fine-tuning | needed ~5k training examples | Would have been the long-term play. We didn't have 5k labelled examples. |
| **Falcon-7b, Vicuna-13b** | crash on Mac / Colab Free | — | RAM ceiling. Needed A100 with 24GB VRAM minimum. |
| **Orca** (Microsoft) | — | — | "Will be open-sourced in 2–3 months." Notes from June 2023. |

In hindsight every wall on the right column is the same wall: in 2023 you had two choices — pay OpenAI/Google per token, or run something local that was 5× slower and 10× less accurate. There was no "small, capable, runs on a single GPU" sweet spot yet. That came later in 2023 with Mistral, and exploded in 2024.

## What it cost to run, in real cluster numbers

The production deploy ran two AIDA backends side by side on `dev-gcp`. From the resource utilization charts in the design doc:

**`aida` (BARD) backend** — light, mostly idle except during inference:

![Kloudfuse metrics chart of aida (BARD) container CPU and memory over a 10-minute window. CPU spikes to ~1.5B nanoCores during requests, baseline near zero. Memory steady at ~800MB.](/images/aida/aida-bard-resources.png)

Peak ~1.5B nanoCores (1.5 vCPU) on inference, 900MB resident memory. The CPU spikes are individual requests; baseline is essentially zero because the LLM call lives in Google's infrastructure, not ours.

**`aida-thirdai` backend** — heavier, because ThirdAI's UDT loads the index locally:

![Kloudfuse metrics chart of aida-thirdai container CPU and memory. CPU bursts to ~2.4B nanoCores. Memory holds at ~3.6B bytes baseline with occasional spikes.](/images/aida/aida-thirdai-resources.png)

Peak ~2.4 vCPU, 3.6GB resident memory — more than 2× the BARD-only backend, and the memory floor is the loaded vector index, not idle bloat. That's the cost of doing retrieval in-process versus calling out to a hosted vector DB.

`dev-gcp` runs `e2-highmem-4` nodes — 4 vCPU, 32GB RAM. At Google's published prices that's ~$152/month per node:

![GCP machine type pricing table showing e2-highmem-2 ($76/month, 2 vCPU, 16GB) and e2-highmem-4 ($152/month, 4 vCPU, 32GB) for the Taiwan region.](/images/aida/gcp-e2-highmem-pricing.png)

So one `aida-thirdai` pod consumed roughly 60% of a node at peak. Two of these per cluster — plus the OpenAI/Google API charges on top — is not a hobby project anymore.

## What actually surprised me

A few things I wrote down at the time that I'd still write down today:

**Prompts don't port between models.** From the 22 June notes: *"For different models, the same prompt template not yield best results. It needs to be formatted by testing for each model separately."* This sounds obvious in 2026. In 2023, the prevailing assumption was that a "good prompt" was a property of the prompt, not of the (model, prompt) pair. We learned otherwise the hard way — the BARD prompt that produced clean PromQL produced free-form English from gpt4all.

**Local LLMs serialise, even when you don't want them to.** gpt4all running on a single CPU pod meant every user request blocked behind the previous one. Two simultaneous users → second user waits 60s. Three users → the third user might watch the pod OOM and restart before getting a response. The fix in 2023 was "queue + retry"; the fix in 2024+ is "vLLM / SGLang batches them properly."

**Retrieval ≠ generation, and conflating them costs you.** ThirdAI's UDT model looked like a complete answer in its docs — natural language in, "answer" out. In practice it returned *the most similar row from your training set*, verbatim. That's retrieval, not generation. Useful as a layer in the pipeline, but you still need a generative LLM downstream to turn the retrieved context into the actual answer. The Google Colab notebook in the design doc showed BARD doing exactly that — taking ThirdAI's retrieved rows as context and generating the final PromQL.

**The training data was the bottleneck.** Several model rows on the scorecard say "would work with ~5k training instructions." We never crossed that threshold. The 230 hand-curated rows we had were enough to pre-train BARD on Kloudfuse's metric names and PromQL idioms, but not enough to fine-tune a 7B-parameter model from scratch. Building the dataset would have been a 2-month full-time job for one engineer. We did the smaller, cheaper thing — prompt engineering with retrieved context — and got 4/5 to 5/5 accuracy out of it. That tradeoff has aged well.

## A worked example

The cleanest comparison from the notes — same question, three model answers:

> **Q:** Return all time series with the metric `http_requests_total` and the given job and handler labels.

```promql
# OpenAI
http_requests_total{job="job_name", handler="handler_name"}
```

```promql
# Bard
http_requests_total{job="apiserver", handler="/api/comments"}
```

```promql
# gpt4all
http_request_duration_seconds_bucket{job="api", handler="/api/comments"}
```

OpenAI gives you the correct templated query. BARD gives you a runnable query (with plausible values guessed from context). gpt4all wanders off and changes the metric. All three are technically "valid PromQL"; only the first two are *correct*. The lesson: model accuracy isn't whether the output parses — it's whether the output is the query you asked for.

A messier one, where everyone struggled:

> **Q:** Find unstable nodes.

```promql
# OpenAI
sum(rate(node_unschedulable{job="kube-state-metrics"}[5m])) by (node) > 0
```

```promql
# gpt4all
UNSTABLE_NODES = node_network_receive_bytes_total{interface="eth0"} >
  (node_filesystem_avail_bytes{filesystem="example_filesystem"} * 100) /
  node_filesystem_size_bytes{filesystem="example_filesystem"}
```

```promql
# Bard
kube_node_status_condition{status="True", condition="Ready"}
```

"Unstable node" isn't a defined PromQL concept; the model has to *interpret*. OpenAI picks an aggressive interpretation (schedule failures). BARD picks the simplest one (just expose the readiness condition and let the user filter). gpt4all hallucinates an assignment statement — that's not PromQL syntax. The takeaway: ambiguous questions are where the gap between the models is largest. Concrete questions ("CPU usage of container X in namespace Y over 5 minutes") narrow the gap to almost nothing.

## How it connects to what I do now

Three years on, my work has moved one layer down. AIDA tried to *generate* the queries; today I work on the engine that *runs* them — query priority, rule-based metric shaping, histogram correctness in the Pinot-backed PromQL path. The two ends of the stack feel further apart on paper than they do in practice. Both come back to the same question: *what does the user actually want, and how do we get them there for the lowest cost?*

The retrieval-augmented prompting AIDA pioneered (locally, at Kloudfuse) is now table stakes. Every "ask my notes" widget on every personal site — [including the one on this site](/) — works the same way AIDA did: chunk the corpus, embed, store, similarity search at query time, hand the top-K to an LLM, stream the answer back. The only differences are that the models are cheaper, the vector stores are managed, and the prompting libraries do the boilerplate for you. The pattern hasn't moved.

If I were starting AIDA in 2026 I'd:

- Skip three of the four backends. Pick one capable model (Claude Sonnet, GPT-4o, Gemini Flash) and let it absorb both the retrieval-and-generation halves. The "run three backends in parallel and compare" framing was a 2023-specific hedge against any single model being too weak.
- Use a managed vector DB (Pinecone, Turbopuffer, even pgvector) instead of running ThirdAI's UDT in-process. Saves the 3.6GB resident memory and the cold-start.
- Spend the saved budget on the training-data half — that was the actual bottleneck, and it still is.
- Build the eval suite *first*. The 2023 design doc has no mention of an automated eval — just "tried different prompts, BARD seems to answer best." Today I'd start with a held-out set of 100 questions, run every model variant against it nightly, track regression on a leaderboard. That's the part that ages.

The original Confluence design doc, with the per-model notes, the resource numbers, and the training-data design, is still the most honest record of what was actually hard in mid-2023. This post is the public version of it.
