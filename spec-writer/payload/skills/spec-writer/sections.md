# Sections

The headings are fixed (`sections.json`), the order is the template's. A project adds its own sections in its project
file; they never replace these.

## Outcome

One or two sentences on what changes for the person who uses the result, and the link to the task card. It tells the
coder and the reviewer which of two readings of a line serves the purpose. Not a summary of the spec.

## Contract

Every route — method, path, query and body DTO by type name, the response with a JSON example; every background job,
CLI command and environment variable. Parallel parts (back and front) are built from this alone, so it is exact: a
field named differently here and in the code is a broken integration found on stand. The project file names the format
(validator, docs annotations). No external contract → «none: <why>».

## Decisions

The seams, not the bodies:
- every new or changed file at its final path;
- each class and function with its full signature in the real types — open the types it imports, never write them
  from memory — and one line on what it does;
- the task's main query whole, SQL or builder: a query is where a shape most often goes wrong, and its plan was
  measured before writing;
- a dependency diagram (Mermaid) for a new module or a real change in who calls whom; types alone need none;
- every place there was a choice, one line: `**<decision>** — why; **instead of** <option> — why not; **minus** — what
  we pay`. A choice the spec does not make, the coder makes — and the owner meets it in review.

No function bodies, no step-by-step code. One example snippet only where a convention is not visible in the code.
OpenSpec's test for what belongs in a behaviour spec applies here in reverse: if the implementation could change
without changing anything visible from outside, it is a decision only when changing it would change a seam.

## Acceptance

Numbered lines, `- **П1** — <behaviour visible from outside> → \`<test or command>\`` (`A1` in English). Behaviour, not
internals: «the second import of the same file changes nothing», not «the hash is checked». Every line names the test
or the command that proves it; the coder hands back that command's output. Tests come from real cases in the data and
past breakages, not from enumerating parameters.

## Where it bites

Three to five inputs or states the task is silent about but a real user or real data will produce: a re-run, a
partial failure, an empty or huge input, an old row from before this change, a neighbour feature touching the same
data, the same file sent twice. Each with what a person would expect and the test that pins it, in the part that owns
the code. This is the section the past rework came from — a fallback column overwriting inherited data, old labels
still expected by old tests — so it is never empty in a full spec.

## Parts

Who builds what — back, front, a mockup — with the files each owns and the command each runs. Files never overlap
between parts; when two parts must touch one file, one part owns it and the other asks. Tests that write to a shared
database run in one part only, or the executors overwrite each other's rows. Open tasks touching the same files are
named here, with what to do about it (rebase on, wait for, own the shared import).

## When the spec is silent

The block from `silence-rule.md` in the spec's language, plus this task's own stops («`orders` gets no migration —
stop»). The coder reads this section before writing; it overrides the coder's default to assume.

## Deviations

Empty when the spec is written. The coder adds a line for each choice it made itself and each stop it hit, with the
reason; it edits nothing else in the spec. The reviewer reads the code against the spec plus these lines.
