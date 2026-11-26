# The builder check

After spec-lint is clean, start agent `spec-builder-check` with the spec's path and the commit or worktree the code is
to be built on. A spec that changed after a coder's stop gets the check again, naming the changed section.

Its report has five lists — questions, lines the code contradicts, inputs nobody tests, asks read narrower than
their words, breaks of a written project rule. Sort every item:

- **Answered already** — by the conversation, the card or the code. Write the answer into the spec; the coder will not
  have the conversation either.
- **Yours to settle** — a competent builder would decide it without changing what gets built. Decide it, write it into
  «Decisions» marked as your call, so the owner can check those calls while reading.
- **The owner's** — only they can answer, and the answer changes what gets built. Bring these in one message, most
  important first; update the spec with the answers.

«Contradicts the code» items are always fixed in the spec, never handed to the coder to «adapt». A broken project rule
is fixed in the spec too; a rule you hold does not fit this case goes into «Decisions» with the rule and the reason, for
the owner to read. An untested input that matters goes into «Where it bites» with its test; one that does not is
dropped without comment.

The check is done when its second run on the fixed spec returns nothing new of the first two kinds or a broken rule.
The owner sees the spec after that, with the list of your calls — not before.
