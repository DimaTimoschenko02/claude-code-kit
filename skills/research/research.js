export const meta = {
  name: 'research',
  description: 'Parameterized web-research harness — fan-out search, batched fetch+extract grounded claims (extraction runs inside WebFetch so pages never enter agent context), optional verification (none/critic/adversarial), synthesize a cited report. Cost scales with mode; models routed cheap-by-default.',
  whenToUse: 'Launched by the `research` skill with a config object. Not meant to be called by hand — the skill picks angles/sources/verify/models per question. args = {question, angles, maxSources, verify, votes, maxClaims, batchSize, reader, models}.',
  phases: [
    { title: 'Scope', detail: 'Decompose question into N search angles' },
    { title: 'Search', detail: 'N parallel WebSearch agents (barrier), one per angle' },
    { title: 'Fetch', detail: 'Global dedup+rank, batched fetch; extraction runs inside WebFetch so full pages never enter agent context' },
    { title: 'Verify', detail: 'none | critic (1-pass) | adversarial (N-vote)' },
    { title: 'Synthesize', detail: 'Merge dupes, rank by confidence, cite sources' },
  ],
}

// research: parameterized port of deep-research.
// Scope → parallel(Search) → global rank → batched Fetch+Extract → [verify tail] → Synthesize.
//
// Token model (why it's built this way):
//   - WebFetch already converts pages to markdown AND runs a prompt over them with a
//     small model, returning only the answer. So extraction is pushed INTO the WebFetch
//     prompt: the page is processed in-place and only compact claims come back — the full
//     page never bloats the fetch-agent's context (this was the dominant cost: ~175k/fetch).
//   - Fetches are BATCHED: one agent handles several sources, amortizing the fixed
//     per-agent setup (~46k of system prompt + tool schemas) over many sources. Because
//     pages no longer enter the agent, batching adds no re-read penalty.
//   - No per-page token cap: fetch everything worth fetching. Efficiency comes from the
//     architecture, not from truncating real content.

// ─── Config ───
// args may arrive as an OBJECT or as a JSON STRING — the Workflow tool serializes
// object args to a string before they reach the script. Parse both robustly:
// without this a JSON-string config silently falls back to defaults and ALL mode
// tuning (lite/normal/deep, model routing) becomes a no-op. (This was a real bug.)
let cfg = {}
if (args && typeof args === "object") {
  cfg = args
} else if (typeof args === "string") {
  const s = args.trim()
  if (s.startsWith("{")) { try { cfg = JSON.parse(s) } catch { cfg = { question: s } } }
  else cfg = { question: s }
}
const QUESTION = (cfg.question || "").trim()
const ANGLES = clampInt(cfg.angles, 4, 1, 8)
const MAX_SOURCES = clampInt(cfg.maxSources, 16, 1, 40)
const VERIFY = ["none", "critic", "adversarial"].includes(cfg.verify) ? cfg.verify : "critic"
const VOTES = clampInt(cfg.votes, 3, 1, 5)
const MAX_CLAIMS = clampInt(cfg.maxClaims, 25, 1, 60)
const REFUTATIONS_REQUIRED = Math.ceil(VOTES / 2) // majority of votes kills a claim
const BATCH = clampInt(cfg.batchSize, 4, 1, 8)     // sources per fetch-agent (amortizes setup)

// Per-phase model routing. Cheap-by-default; skill overrides per mode.
const M = (cfg.models && typeof cfg.models === "object") ? cfg.models : {}
const M_SCOPE = M.scope || "haiku"
const M_SEARCH = M.search || "haiku"
const M_EXTRACT = M.extract || "haiku"
const M_VERIFY = M.verify || (VERIFY === "critic" ? "sonnet" : "haiku")
const M_SYNTH = M.synth || "sonnet"

// Reader strategy for the in-WebFetch fetch step:
//   "auto"   (default) — WebFetch the original URL; on empty/blocked/JS-wall retry once
//                        via r.jina.ai (renders JS). Cheap for normal pages, robust for SPAs.
//   "jina"   — always go through r.jina.ai first (use for known JS-heavy domains, e.g. shops).
//   "direct" — original URL only, no proxy (use if jina is down/blocked).
const READER = ["auto", "jina", "direct"].includes(cfg.reader) ? cfg.reader : "auto"

// Source gating. Default-skip known low-value hosts + listing/category/search URLs
// (they yield 0 extractable claims and burn the heaviest phase). Caller can extend.
const DEFAULT_AVOID = ["pinterest.com", "quora.com", "answers.com"]
const avoidDomains = (Array.isArray(cfg.avoidDomains) ? cfg.avoidDomains : [])
  .concat(DEFAULT_AVOID).map(d => String(d).toLowerCase())
const preferDomains = (Array.isArray(cfg.preferDomains) ? cfg.preferDomains : [])
  .map(d => String(d).toLowerCase())

function clampInt(v, def, lo, hi) {
  const n = Number.isFinite(v) ? Math.round(v) : def
  return Math.max(lo, Math.min(hi, n))
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase() } catch { return "" } }
const inList = (u, list) => { const h = hostOf(u); return list.some(d => h === d || h.endsWith("." + d)) }
// Listing/category/search/tag pages rarely hold extractable prose — skip pre-fetch.
const isListingUrl = u => /(\/c\d{4,}(\/|$)|\/category\/|\/categories\/|\/catalog\/|\/search(\/|\?|$)|\/ask\/|\/tag\/|\/tags\/|\/topics\/)/i.test(u)
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["question", "angles", "summary"],
  properties: {
    question: { type: "string" },
    summary: { type: "string" },
    angles: { type: "array", minItems: 1, maxItems: 8, items: {
      type: "object", required: ["label", "query"],
      properties: {
        label: { type: "string" },
        query: { type: "string" },
        rationale: { type: "string" },
      },
    }},
  },
}
const SEARCH_SCHEMA = {
  type: "object", required: ["results"],
  properties: {
    results: { type: "array", maxItems: 6, items: {
      type: "object", required: ["url", "title", "relevance"],
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        snippet: { type: "string" },
        relevance: { enum: ["high", "medium", "low"] },
      },
    }},
  },
}
// Batched extractor returns one entry per source URL in the batch.
const BATCH_EXTRACT_SCHEMA = {
  type: "object", required: ["sources"],
  properties: {
    sources: { type: "array", items: {
      type: "object", required: ["url", "sourceQuality", "claims"],
      properties: {
        url: { type: "string" },
        sourceQuality: { enum: ["primary", "secondary", "blog", "forum", "unreliable"] },
        publishDate: { type: "string" },
        claims: { type: "array", maxItems: 5, items: {
          type: "object", required: ["claim", "quote", "importance"],
          properties: {
            claim: { type: "string" },
            quote: { type: "string" },
            importance: { enum: ["central", "supporting", "tangential"] },
          },
        }},
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    counterSource: { type: "string" },
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings", "caveats"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["claim", "confidence", "sources", "evidence"],
      properties: {
        claim: { type: "string" },
        confidence: { enum: ["high", "medium", "low"] },
        sources: { type: "array", items: { type: "string" } },
        evidence: { type: "string" },
      },
    }},
    caveats: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
    cut: { type: "array", items: { type: "string" } }, // critic mode: claims dropped/downgraded
  },
}

// ─── Phase 0: Scope ───
phase("Scope")
if (!QUESTION) {
  return { error: "No research question. Pass args: {question, angles, maxSources, verify, models}." }
}
log(`mode: ${VERIFY} · ${ANGLES} angles · ${MAX_SOURCES} sources · batch ${BATCH} · reader ${READER} · models[extract=${M_EXTRACT} synth=${M_SYNTH}]`)

const scope = await agent(
  "Decompose this research question into complementary search angles.\n\n" +
  "## Question\n" + QUESTION + "\n\n" +
  "## Task\n" +
  "Generate exactly " + ANGLES + " distinct web search queries that together cover the question from different angles. Pick angles that suit the question's domain. Examples:\n" +
  "- broad/primary · academic/technical · recent news · contrarian/skeptical · practitioner/implementation\n" +
  "- For a product/purchase: top picks · expert reviews · long-term reliability/complaints · price/deals · alternatives\n" +
  "- For tech: state-of-art · benchmarks · limitations · adoption · cost/tradeoffs\n\n" +
  "Make queries specific enough to surface high-signal results. Avoid redundancy.\n" +
  "Return: the question (verbatim or lightly normalized), a 1-2 sentence strategy, and the angles.\n\nStructured output only.",
  { label: "scope", phase: "Scope", schema: SCOPE_SCHEMA, model: M_SCOPE }
)
if (!scope) return { error: "Scope agent returned nothing — cannot decompose the question." }
log("Q: " + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? "…" : ""))
log("Angles: " + scope.angles.map(a => a.label).join(", "))

// ─── Dedup / gating state ───
const normURL = u => {
  try {
    const p = new URL(u)
    return (p.hostname.replace(/^www\./, "") + p.pathname.replace(/\/$/, "")).toLowerCase()
  } catch { return u.toLowerCase() }
}
const seen = new Map()
const dupes = []
const budgetDropped = []
const relRank = { high: 0, medium: 1, low: 2 }

// ─── Prompts ───
const SEARCH_PROMPT = (angle) =>
  "## Web Searcher: " + angle.label + "\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "Your angle: **" + angle.label + "** — " + (angle.rationale || "") + "\n" +
  "Search query: `" + angle.query + "`\n\n" +
  "## Task\nUse WebSearch with the query above (or a refined version). Return the top 4-6 most relevant results.\n" +
  "Rank by relevance to the ORIGINAL question, not just the search query.\n" +
  "PREFER direct, content-rich pages: articles, reviews, documentation, product-detail pages, primary sources, GitHub/official docs.\n" +
  "AVOID and do NOT return: shop category/listing pages (e.g. /category/, /catalog/, /c12345/), search-result and tag pages, SEO 'top-10 / best X 2025' content-farm listicles, and link aggregators — they rarely yield extractable facts.\n" +
  "Include a short snippet capturing why each result is relevant.\n\nStructured output only."

// Reader-specific fetch instruction injected into the batch extractor.
const readerInstr =
  READER === "jina"
    ? "Fetch each source THROUGH Jina (renders JS, strips boilerplate): set the WebFetch `url` to `https://r.jina.ai/` followed by the source URL."
    : READER === "direct"
    ? "Fetch each source URL directly with WebFetch. Do not use any proxy."
    : "Fetch each source URL directly with WebFetch first. If WebFetch reports the page empty / blocked / requiring JavaScript / returns NO_CONTENT, retry THAT source ONCE with the WebFetch `url` set to `https://r.jina.ai/` followed by the source URL (it renders JavaScript)."

// The batch extractor: extraction happens INSIDE each WebFetch call (its `prompt`),
// so only compact claims return — full pages never enter this agent's context.
const FETCH_PROMPT = (batch) =>
  "## Source Extractor — extract claims WITHOUT pulling pages into your context\n\n" +
  "Research question: \"" + QUESTION + "\"\n\n" +
  "You will process the " + batch.length + " source(s) below. **Token rule (critical):** for each source make ONE WebFetch call whose `prompt` performs the extraction *inside* WebFetch, so only the small extracted result returns to you. NEVER instruct WebFetch to return the page, the full text, or the raw content — that defeats the entire purpose and wastes tokens.\n\n" +
  "## Sources\n" +
  batch.map((s, i) => (i + 1) + ". " + s.url + "  —  " + (s.title || "")).join("\n") + "\n\n" +
  "## Fetch method\n" + readerInstr + "\n" +
  "If WebFetch returns a cross-host redirect URL instead of content, call it once more with the same prompt.\n\n" +
  "## WebFetch `prompt` to use for EVERY source (this is what does the extraction)\n" +
  "\"Extract 2-5 FALSIFIABLE claims from this page that bear on the question: " + QUESTION + ". " +
  "For each claim give: a concrete, checkable statement; a DIRECT VERBATIM QUOTE copied from the page that supports it; and importance = central|supporting|tangential. " +
  "Also state the source quality (primary|secondary|blog|forum|unreliable) and the publish date if shown. " +
  "Ignore navigation, ads, comments, related-articles and sidebars. If the page is irrelevant, paywalled, empty or blocked, reply with exactly: NO_CONTENT.\"\n\n" +
  "## Output\n" +
  "Emit ONE StructuredOutput with a `sources` array — exactly one entry per source URL above, echoing the EXACT url given. Each entry: url, sourceQuality, publishDate (if any), and claims[]. " +
  "Drop any claim that lacks a verbatim quote (grounding is mandatory — no quote, no claim). For a NO_CONTENT / failed / irrelevant source, still include its entry with sourceQuality \"unreliable\" and claims: []. " +
  "Do not re-fetch a source for extra detail; minimise your turns. Structured output only."

const VERIFY_PROMPT = (claim, v) =>
  "## Adversarial Claim Verifier (voter " + (v + 1) + "/" + VOTES + ")\n\n" +
  "Be SKEPTICAL. Try to REFUTE this claim. ≥" + REFUTATIONS_REQUIRED + "/" + VOTES + " refutations kill it.\n\n" +
  "## Research question\n" + QUESTION + "\n\n" +
  "## Claim under review\n\"" + claim.claim + "\"\n\n" +
  "**Source:** " + claim.sourceUrl + " (" + claim.sourceQuality + ")\n" +
  "**Supporting quote:** \"" + claim.quote + "\"\n\n" +
  "## Checklist\n" +
  "1. Is the claim actually supported by the quote, or an overreach/misread?\n" +
  "2. WebSearch for contradicting evidence — does any credible source dispute or heavily qualify this?\n" +
  "3. Is source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
  "4. Is the claim outdated? (old claims about fast-moving fields are suspect)\n" +
  "5. Is this marketing / press release / cherry-picked benchmark / forum speculation?\n\n" +
  "**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\n" +
  "**refuted=false** ONLY if: well-supported, current, and source quality matches claim strength.\n" +
  "Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST be specific."

// ─── Search (barrier) ───
phase("Search")
const rawSearches = (await parallel(
  scope.angles.map(angle => () =>
    agent(SEARCH_PROMPT(angle), {
      label: "search:" + angle.label, phase: "Search", schema: SEARCH_SCHEMA, model: M_SEARCH,
    }).then(r => {
      if (!r) return null
      log(angle.label + ": " + r.results.length + " results")
      return { angle: angle.label, results: r.results }
    })
  )
)).filter(Boolean)

// ─── Global dedup + source-gating + rank → cap to MAX_SOURCES ───
const prefRank = u => (preferDomains.length && inList(u, preferDomains)) ? 0 : 1
const flat = rawSearches.flatMap(sr => sr.results.map(r => ({ ...r, angle: sr.angle })))
flat.sort((a, b) =>
  (prefRank(a.url) - prefRank(b.url)) || (relRank[a.relevance] - relRank[b.relevance]))

const ranked = []
for (const r of flat) {
  const key = normURL(r.url)
  if (seen.has(key)) { dupes.push({ ...r, dupOf: seen.get(key) }); continue }
  if (inList(r.url, avoidDomains) || isListingUrl(r.url)) {
    budgetDropped.push({ ...r, reason: "low-value-url" }); continue
  }
  if (ranked.length >= MAX_SOURCES) { budgetDropped.push({ ...r, reason: "budget" }); continue }
  seen.set(key, { angle: r.angle, title: r.title })
  ranked.push(r)
}
log("Sources: " + ranked.length + " selected (" + dupes.length + " dup, " + budgetDropped.length + " gated/over-budget)")

// url → {title, angle} so we can map batch output back to source metadata.
const metaByUrl = new Map(ranked.map(r => [normURL(r.url), { title: r.title, angle: r.angle }]))

// ─── Batched Fetch+Extract (extraction runs inside WebFetch) ───
phase("Fetch")
const batches = chunk(ranked, BATCH)
const batchResults = await parallel(
  batches.map((batch, bi) => () => {
    let host = "batch" + (bi + 1)
    try { host = new URL(batch[0].url).hostname.replace(/^www\./, "") } catch {}
    const lbl = "fetch:" + host + (batch.length > 1 ? "+" + (batch.length - 1) : "")
    return agent(FETCH_PROMPT(batch), {
      label: lbl, phase: "Fetch", schema: BATCH_EXTRACT_SCHEMA, model: M_EXTRACT,
    }).then(res => {
      if (!res || !Array.isArray(res.sources)) return []
      return res.sources.map(s => {
        const m = metaByUrl.get(normURL(s.url)) || {}
        return {
          url: s.url, title: m.title || s.url, angle: m.angle || "?",
          sourceQuality: s.sourceQuality, publishDate: s.publishDate,
          claims: (s.claims || []).map(c => ({ ...c, sourceUrl: s.url, sourceQuality: s.sourceQuality })),
        }
      })
    }).catch(e => {
      log("batch failed (" + lbl + "): " + (e.message || e))
      return []
    })
  })
)

const allSources = batchResults.filter(Boolean).flat()
const allClaims = allSources.flatMap(s => s.claims)
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }

const rankedClaims = [...allClaims]
  .sort((a, b) => (impRank[a.importance] - impRank[b.importance]) || (qualRank[a.sourceQuality] - qualRank[b.sourceQuality]))
  .slice(0, MAX_CLAIMS)

log("Fetched " + allSources.length + " sources → " + allClaims.length + " claims → using top " + rankedClaims.length + " (verify: " + VERIFY + ")")

const baseStats = () => ({
  mode: VERIFY, angles: scope.angles.length, sourcesFetched: allSources.length,
  claimsExtracted: allClaims.length, urlDupes: dupes.length, budgetDropped: budgetDropped.length,
})
const sourceList = () => allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length }))

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary: "No claims extracted. " + allSources.length + " sources fetched, all empty/failed.",
    findings: [], sources: sourceList(), stats: { ...baseStats(), claimsUsed: 0 },
  }
}

// ─── claim block builder (shared by synth + critic) ───
const claimBlock = (claims) => claims.map((c, i) =>
  "### [" + i + "] " + c.claim + "\n" +
  "Source: " + c.sourceUrl + " (" + c.sourceQuality + ") · importance: " + c.importance + "\n" +
  "Quote: \"" + c.quote + "\"\n"
).join("\n")

const SYNTH_PROMPT = (claims, verifiedNote) =>
  "## Synthesis: research report\n\n" +
  "**Question:** " + QUESTION + "\n\n" +
  claims.length + " claims collected from " + allSources.length + " sources. " + verifiedNote + "\n\n" +
  "## Claims\n" + claimBlock(claims) + "\n\n" +
  "## Instructions\n" +
  "1. Merge claims that say the same thing — combine their sources.\n" +
  "2. Group related claims into coherent findings, each directly addressing the question.\n" +
  "3. Confidence per finding: high (multiple primary sources agree), medium (secondary or partial), low (single source or blog/forum).\n" +
  "4. Write a 3-5 sentence executive summary answering the question.\n" +
  "5. Caveats: what's uncertain, weak sources, time-sensitivity.\n" +
  "6. List 2-4 open questions that emerged.\n\nStructured output only."

let report
let killed = []

if (VERIFY === "adversarial") {
  // ─── N-vote adversarial filter (barrier: full claim pool ranked first) ───
  phase("Verify")
  const voted = (await parallel(
    rankedClaims.map(claim => () =>
      parallel(
        Array.from({ length: VOTES }, (_, v) => () =>
          agent(VERIFY_PROMPT(claim, v), {
            label: "v" + v + ":" + claim.claim.slice(0, 36), phase: "Verify", schema: VERDICT_SCHEMA, model: M_VERIFY,
          })
        )
      ).then(verdicts => {
        const valid = verdicts.filter(Boolean)
        const refuted = valid.filter(v => v.refuted).length
        const abstained = VOTES - valid.length
        const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
        log("\"" + claim.claim.slice(0, 50) + "…\": " + (valid.length - refuted) + "-" + refuted + (abstained ? " (" + abstained + " abst)" : "") + " " + (survives ? "✓" : "✗"))
        return { ...claim, verdicts: valid, refutedVotes: refuted, survives }
      })
    )
  )).filter(Boolean)

  const confirmed = voted.filter(c => c.survives)
  killed = voted.filter(c => !c.survives)
  log("Verify: " + voted.length + " claims → " + confirmed.length + " confirmed, " + killed.length + " killed")

  if (confirmed.length === 0) {
    return {
      question: QUESTION,
      summary: "All " + voted.length + " claims refuted by adversarial verification. Inconclusive — sources weak or claims overstated.",
      findings: [],
      refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl })),
      sources: sourceList(), stats: { ...baseStats(), claimsUsed: voted.length, confirmed: 0, killed: killed.length },
    }
  }

  phase("Synthesize")
  report = await agent(
    SYNTH_PROMPT(confirmed, confirmed.length + " claims survived " + VOTES + "-vote adversarial verification."),
    { label: "synthesize", phase: "Synthesize", schema: REPORT_SCHEMA, model: M_SYNTH }
  )

} else if (VERIFY === "critic") {
  // ─── 1-pass critic: draft synth → skeptical review/rewrite ───
  phase("Synthesize")
  const draft = await agent(
    SYNTH_PROMPT(rankedClaims, "Claims are grounded by quotes but NOT independently verified — synthesize a first draft."),
    { label: "synth-draft", phase: "Synthesize", schema: REPORT_SCHEMA, model: M_SYNTH }
  )
  if (!draft) {
    report = null
  } else {
    phase("Verify")
    report = await agent(
      "## Critic pass — verify a draft research report against its source claims\n\n" +
      "**Question:** " + QUESTION + "\n\n" +
      "## Draft findings\n" + draft.findings.map((f, i) =>
        "### [" + i + "] " + f.claim + " (confidence: " + f.confidence + ")\n" + f.evidence + "\nSources: " + (f.sources || []).join(", ")
      ).join("\n") + "\n\n" +
      "## Source claims (ground truth — each has a quote)\n" + claimBlock(rankedClaims) + "\n\n" +
      "## Task\nReview the draft skeptically against the source claims:\n" +
      "1. Each finding must be grounded in at least one source claim/quote. DROP findings with no grounding.\n" +
      "2. DOWNGRADE confidence where it overstates the evidence (single blog/forum source ≠ high).\n" +
      "3. Flag marketing fluff, outdated claims, cherry-picked benchmarks — drop or caveat them.\n" +
      "4. Keep the executive summary honest about what's actually supported.\n" +
      "5. List in `cut` any claim you dropped or downgraded and why.\n\n" +
      "Return the corrected report. Structured output only.",
      { label: "critic", phase: "Verify", schema: REPORT_SCHEMA, model: M_VERIFY }
    ) || draft // critic skipped → fall back to draft
  }

} else {
  // ─── none: grounded claims straight to synth ───
  phase("Synthesize")
  report = await agent(
    SYNTH_PROMPT(rankedClaims, "Claims are grounded by quotes at extraction (no separate verification pass — this is the fast mode)."),
    { label: "synthesize", phase: "Synthesize", schema: REPORT_SCHEMA, model: M_SYNTH }
  )
}

if (!report) {
  return {
    question: QUESTION,
    summary: "Synthesis was skipped or failed — returning " + rankedClaims.length + " grounded claims unmerged.",
    findings: [],
    claims: rankedClaims.map(c => ({ claim: c.claim, source: c.sourceUrl, quote: c.quote })),
    refuted: killed.map(c => ({ claim: c.claim, source: c.sourceUrl })),
    sources: sourceList(), stats: { ...baseStats(), claimsUsed: rankedClaims.length, synthesized: 0 },
  }
}

return {
  question: QUESTION,
  ...report,
  refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + "-" + c.refutedVotes, source: c.sourceUrl })),
  sources: sourceList(),
  stats: {
    ...baseStats(),
    claimsUsed: rankedClaims.length,
    confirmed: VERIFY === "adversarial" ? (rankedClaims.length - killed.length) : undefined,
    killed: killed.length || undefined,
    findings: report.findings.length,
  },
}
