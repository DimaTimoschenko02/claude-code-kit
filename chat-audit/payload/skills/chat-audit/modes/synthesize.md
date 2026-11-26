# Mode 6 — synthesize

Connect the verified session and memory evidence before deciding what to propose. Run one fresh agent on the
resolved plan's `synthesis` route. No findings or verified new-lens candidates after the preceding checks →
skip both synthesis and critic, and tell `land.md` what was covered and found clean.

## Evidence packet

Send the goal, scope and destination; compact verified findings with stable IDs; verified free-reader lens
candidates; the recon inventory and previous verdicts from the ledger; and paths to slice.json, freq.json,
agents.json when relevant, memory-drift results and the affected instruction files. Include the source anchors,
not just another agent's conclusions. Keep the initial packet to that decision material; the agent may open
the structured slices and targeted rule or memory files to test a claim. Raw transcripts stay with the
extractors. Never fork the parent conversation or paste its tool history into the packet.

Use the phase's explicit model, effort and escalation description. A host that cannot launch that model
reports the unavailable synthesis phase rather than silently assigning it to the main session or a reader.

## Assignment

Find the cause behind the evidence: which apparently different findings share a mechanism, which contradict
one another, and whether the proposed remedy changes that mechanism. Check the recon and ledger before
calling a rule missing or recommending a previously rejected fix. Preserve differences in scope and evidence;
a shared label alone is not a shared cause. Look for a blind spot suggested by the verified lens candidates,
and name the additional extraction needed when the supplied slice cannot settle it.

Return ranked proposal groups, each with:

```
finding_ids: <the source findings; preserve their anchors and counts>
cause:       <the common mechanism, or why they must stay separate>
evidence:    <anchors and counts supporting that cause; uncertainty explicit>
class:       missing | exists-but-did-not-fire | exists-but-too-broad
change:      <smallest concrete remedy and its owning file/tool>
signal:      <observable result that would show whether it helped>
cost:        <current waste and cost of the proposed remedy>
```

Also return dropped/merged IDs with reasons, unresolved contradictions, and coverage gaps. Do not invent
frequencies, discard rejected alternatives from the record, write the final user report, apply fixes, or
spawn more agents. New evidence claims are candidates until the main session verifies their anchors.

## Independent challenge

The main session verifies any new or changed evidence and sends costly proposals together to one fresh agent
on the plan's `critic` route. Give it the primary evidence, affected rules and ledger, not only the synthesis.
Its job is to show why each proposed change is unnecessary, already covered, outside the goal, unmeasurable,
or more expensive than the waste it removes. Return keep/revise/drop with evidence per proposal. Cheap memory
entries need no hostile read. No costly proposals → no critic call.

Resolve the critique against evidence; do not send the pair into a debate loop. A contradiction that remains
becomes uncertainty or a question for the user. Another model pass needs the revised budget from `select.md`.

## Output

Verified proposals, the independent critique, dropped items and explicit coverage gaps go to `land.md`.
Record the actual models and efforts used for each phase in the report, including skipped or unavailable
phases, so the first audit can establish whether this routing ran rather than merely existed on paper.
