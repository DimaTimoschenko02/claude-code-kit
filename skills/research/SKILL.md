---
name: research
description: Web research dispatcher. Use whenever the user wants to research a topic, find/compare options, or asks to search the web — "поищи в интернете", "загугли", "найди в сети", "что популярно", "сравни", "research X", "поиск в сети", "/research". Assesses scope, proposes a cost-appropriate mode, routes cheap models by default, then runs the `research` workflow. Triage first: trivial single-fact lookups get a direct WebSearch, NOT the workflow.
---

# research — web research dispatcher

Thin orchestrator over the `research` workflow (`.claude/workflows/research.js`). The workflow is the engine; this skill is the brain that decides *how much* research to run and *which models* to use, then launches it.

Built because the bundled `/deep-research` ran ~97 agent calls **all on Opus** — fine for a thesis, absurd for "what mouse to buy".

## Step 1 — Triage: lookup or research?

**Trivial fact lookup** (one current value, a definition, a quick "когда вышло X", "курс гривны", "version of Y") → do ONE `WebSearch` (or `WebFetch`) directly and answer. Do **not** launch the workflow. The workflow is for multi-source synthesis, not single facts.

**Real research** (compare/choose, "what's best/popular", contested topic, needs multiple sources reconciled, a written report) → continue below.

## Step 2 — Specific enough?

If the question is underspecified for a useful report (e.g. "what laptop", "best framework"), ask 2-3 clarifying questions first (budget / use-case / region / constraints) via `AskUserQuestion`, then weave the answers into the question string. Don't research a vague question — you'll get vague mush.

## Domain presets — optional (check after Step 2, before picking the mode)

Some topics need domain knowledge: where to search, what counts as quality, how to phrase the query, what to extract. Keep that out of the skill logic — express it as **preset files** registered in a small table (registry-of-presets, not `if`-soup). This kit ships none by default; add your own.

**Preset registry (example shape — empty by default):**

| Domain | Triggers (topic is about…) | Preset file |
|---|---|---|
| `medical` *(example)* | health, symptoms, labs, supplements, dosages, diet-as-intervention, substance safety | `presets/medical.md` |

**How to apply:** topic matches a domain's triggers → read its preset file and overlay it on the remaining steps — source-tiers → `preferDomains`/`avoidDomains`; evidence-hierarchy + extraction-addendum → extraction instructions; verify-floor → `verify` (a preset may raise verify ABOVE the mode preset — e.g. medical: `critic` minimum); query phrasing (PICO) → into `question`. No domain match → normal flow unchanged.

**Add a domain:** one row in the table above + a `presets/<domain>.md` file. No change to the skill logic.

## Step 3 — Pick the mode

**If the user stated the level in text** ("deep research про X", "по-быстрому глянь", "глубоко копни", "lite") → use that mode directly, skip the ask.

**Otherwise** → assess the question's scope (breadth, how contested, freshness needs, stakes) and offer the **2 modes that fit** via `AskUserQuestion`, each with its est. cost and what it trades off. Don't dump all three blindly — pick the fitting pair:
- shopping / casual / "что популярно" → offer **lite + normal**
- technical / medical / financial / "разберись глубоко" / high-stakes → offer **normal + deep**

Show est. agent-calls so the cost is explicit. Let the user choose.

### Verification intensity — match it to falsification risk, not to mode

`verify` is a separate axis from breadth/depth. Pick it by **how likely the web is to be wrong/biased on this topic**, then override the mode preset if needed:

- **Low risk** (product specs, docs, definitions, "what's popular") — falsification unlikely; the win is *source quality*, not claim-checking → `verify: "none"` (grounding quotes already enforced at extraction). Lean on source-gating instead.
- **Medium risk** (purchases in affiliate-heavy markets, opinionated comparisons, marketing-saturated topics) → `verify: "critic"` (one skeptical pass strips marketing/ungrounded claims). This is the usual default.
- **High risk** (medical, financial, legal, contested science, anything where a wrong answer costs real money/health) → `verify: "adversarial"` (N skeptics per claim).

So a *small* but *contested* question can be `angles: 3, maxSources: 8, verify: "adversarial"`; a *broad* but *safe* one can be `angles: 5, maxSources: 25, verify: "none"`. Decouple the two.

**Adversarial is only for FACTUAL questions — never for design/philosophy/synthesis.** "Is X true / what are the numbers" can be refuted by a counter-citation; "how should we design X / what's the better approach / extended-mind philosophy" cannot — a skeptic majority structurally kills design claims (observed: 2 of 12 survived, repeatedly). For design/synthesis questions use `verify: "critic"` or plain web-fetch + manual synthesis (or NotebookLM), and do NOT cut the claim budget on broad quality questions — that just drops coverage. Adversarial = fact-checking, not idea-judging.

## Step 4 — Build config & launch

Map the chosen mode to this config and launch with the Workflow tool. Pass `args` as a JSON object (the engine also accepts a JSON string — it parses both, so tuning never silently falls back to defaults).

| mode | angles | maxSources | verify | maxClaims | est. calls |
|---|---|---|---|---|---|
| **lite** | 3 | 8 | `none` (grounding only) | — | ~7 |
| **normal** | 4 | 16 | `critic` (1-pass) | 25 | ~11 |
| **deep** | 5 | 25 | `adversarial` 3-vote | 25 | ~89 |

Fetches are batched (`batchSize`=4 sources/agent), so call-count is far below source-count: e.g. lite = 1 scope + 3 search + 2 fetch + 1 synth = 7. Measured lite ≈ 182k subagent tokens (−45% vs the naive per-source design).

**Model routing (always think — most calls are Haiku):**

| phase | lite | normal | deep |
|---|---|---|---|
| scope | haiku | sonnet | sonnet |
| search | haiku | haiku | haiku |
| extract | haiku | haiku | haiku |
| verify | — | sonnet | haiku |
| synth | sonnet | sonnet | opus |

Config objects to pass as `args`:

```jsonc
// lite
{ "question": "<full question>", "angles": 3, "maxSources": 8, "verify": "none",
  "models": { "scope": "haiku", "search": "haiku", "extract": "haiku", "synth": "sonnet" } }

// normal
{ "question": "<full question>", "angles": 4, "maxSources": 16, "verify": "critic", "maxClaims": 25,
  "models": { "scope": "sonnet", "search": "haiku", "extract": "haiku", "verify": "sonnet", "synth": "sonnet" } }

// deep
{ "question": "<full question>", "angles": 5, "maxSources": 25, "verify": "adversarial", "votes": 3, "maxClaims": 25,
  "models": { "scope": "sonnet", "search": "haiku", "extract": "haiku", "verify": "haiku", "synth": "opus" } }
```

Launch: `Workflow({ name: "research", args: <config object> })`. It runs in the background; you're notified on completion.

You may tune any knob off-preset when the question warrants it (a narrow but contested question → normal angles but `verify: "adversarial"`; a broad survey → more sources, `verify: "none"`). The presets are starting points — adjust and tell the user what you changed.

**Optional knobs (sensible defaults — set only when needed):**
- `reader`: `"auto"` (default) — WebFetch the page directly, fall back to `r.jina.ai` only when it comes back empty/JS-walled. `"jina"` forces the proxy first (use for JS-heavy domains like Rozetka/shops). `"direct"` disables the fallback (jina down). Note: WebFetch already converts pages to markdown, so a clean-reader buys *JS rendering*, not token savings.
- `batchSize`: sources per fetch-agent (default 4). Each agent extracts several sources in one context, amortizing the fixed ~50k/agent setup. Don't crank it — WebFetch responses re-read across turns. 3–5 is the sweet spot.
- `avoidDomains`: `["site.com", …]` — hosts to skip pre-fetch (on top of built-in junk list). Use when a topic has a known spam/aggregator domain.
- `preferDomains`: `["rtings.com", "github.com", …]` — hosts to prioritize in fetch ordering. Use when you know the authoritative sources for the domain.

Engine already skips listing/category/search/tag URLs automatically (they yield no extractable facts).

## Step 5 — Deliver

On completion, present a condensed report: executive summary, key findings with confidence + sources, caveats, open questions. Surface `stats` (sources, claims, calls) briefly so cost is visible.

**Saving the report:** do NOT auto-save. Persist only when the user asks. When they do, write it wherever they keep notes — as a proper document, not a raw dump.

## Notes

- This skill is meant to replace the bundled `/deep-research` (which runs a fixed all-Opus fan-out). If you have that skill enabled and want this one to win, disable it via `skillOverrides` in `.claude/settings.json`.
- `verify` semantics: `none` = trust extraction quotes (grounding); `critic` = one skeptical pass rewrites the draft, dropping ungrounded findings; `adversarial` = N skeptics per claim, majority-refute kills it (expensive — deep only).
- **Fetch architecture is the token lever (measured −45% total / −68% per-source vs the naive per-source design):**
  1. *Extraction-in-WebFetch* — the extraction instructions ride **inside** each `WebFetch` `prompt`, so WebFetch's small model processes the page in place and returns only compact claims. Full pages never enter the fetch-agent's context (that was the dominant ~200k/fetch cost).
  2. *Batched fetch* — one agent extracts `batchSize` sources in a single context, amortizing the fixed ~50k/agent setup over several sources.
  3. *No per-page token cap* — efficiency comes from the architecture, not from truncating real content. WebFetch already markdownifies, so a clean-reader (jina) buys JS-rendering, not tokens.
  Synthesis only ever sees extracted claims (capped at `maxClaims`), never full pages.
- **Iterating on the engine:** `Workflow({name:"research"})` resolves from a registry **cached at session start** — after editing `research.js`, same-session test runs MUST launch via `Workflow({scriptPath:"<abs path to>/.claude/workflows/research.js", args})`; the `name` form only picks up the edit in a fresh session. (Normal usage is unaffected — a new session always loads the current file.)
- Concurrency is capped at ~16 agents; deep's ~90 calls still finish fast wall-clock, but cost real tokens. Default to lite/normal.

## Changelog (v1→v3)

Design history of the engine (forward-relevant lessons live in Notes above).

- **v1 (2026-06-06)** — режимный движок взамен bundled `/deep-research` (тот гнал ~97 вызовов all-Opus). Введены lite/normal/deep + per-phase model-routing (Haiku/Sonnet/Opus) + adaptive scope-pick в диспетчере.
- **v2 (2026-06-06)** — 🔴 критбаг: `args` приходил JSON-строкой → режимы молча не применялись (оба первых прогона шли на дефолтах). Фикс `JSON.parse`. + source-gating до фетча (12/20 фетчей были мусором). Замер: ~4.2M ток/прогон, 95% — cache от засасываемых страниц.
- **v3 (2026-06-07)** — fetch переписан под токен-эффективность: extraction-in-WebFetch (страница не входит в контекст агента — корень ~200k/fetch) + batched fetch. **Измерено: 331k→182k (−45%), per-source 201k→64k (−68%)**, качество сохранено. Урок: тест e2e только через `scriptPath` (`name` кешит скрипт на старте сессии — см. Notes).
