# Mode 0 — intake

Turn a vague ask into an audit that can succeed. This is the step that decides whether the result is two
useless bullets or something worth acting on.

## The rule

Scale the questions to what the user already gave you. Count what is actually in the request:

| The request contains | Do this |
|---|---|
| No goal, no lens, no sessions ("re-read the chats, find what could be faster") | Ask. Maximum 3 questions, each with your own proposed answer attached. |
| Goal **or** lens, but not both ("find where I repeat myself in the karts sessions") | Fill the gaps yourself, state your assumptions in one line, proceed. |
| Goal, lens and scope | Restate in one line for confirmation, proceed. |

Offer an escape in every case: *"or say 'decide for me' and I'll pick"*. When they take it, write the
assumptions down explicitly — they become the audit's contract, and a wrong assumption stated is fixable
while a wrong assumption hidden is not.

## The four things to establish

**1. Goal — what changes if the audit succeeds?**
Not "find problems". Something like: fewer interruptions to answer the same question, less manual repetition,
a skill that stops firing wrongly, faster ramp on a recurring task type.

**2. Lens — which failure mode are we hunting?** Pick from the defaults, or take the user's own:

| Lens | Looks for | Strongest signal in the slice |
|---|---|---|
| `friction` | where work stalled or backtracked | corrections, interruptions, retries, long turns |
| `repetition` | the same thing done by hand again and again | `analyze.mjs` repeated commands, inline code |
| `tooling` | tools/skills/agents missing, unused or misused | skill and agent counts vs what exists in recon |
| `knowledge` | things learned and never written down | files re-read across sessions, repeated questions |
| `rules` | guardrails that misfire or never fire | hook blocks, gates hit on legitimate work |
| `requirements` | what the user asked for, including what got refused | user turns, corrections |

Default when the user has no preference: `friction` + `repetition`. They pay off fastest and need no
project-specific knowledge.

**3. Horizon — which sessions.** Days, a topic, a branch, named sessions. Note it; `select.md` executes it.

**4. Destination — what does a finding become?** A skill, a hook, a memory entry, a CLAUDE.md line, a script,
or just knowing. This determines what the analysis must produce: a finding destined for a hook needs a
deterministic trigger condition; one destined for memory needs a durable statement of fact. Ask this even when
everything else is clear — it is the question people skip, and skipping it is why audits end in a list nobody
uses.

## Output of this mode

One short block, shown to the user before continuing:

```
goal:        <what improves>
lens:        <one or two>
horizon:     <days / topic / named sessions>
destination: <skill | hook | memory | instructions | script | just knowing>
assumptions: <only if you filled gaps yourself>
```

Then go to `recon.md`.

## Do not

- Do not ask a fourth question. Three is the ceiling; anything else you infer and state.
- Do not start reading sessions "to understand the question better". Recon first, and recon reads infra, not chats.
- Do not accept "find everything" as a lens. Everything is not a lens; it is the absence of one. Offer the
  default pair instead.
