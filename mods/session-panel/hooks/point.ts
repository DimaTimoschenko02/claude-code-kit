// Where the stop-point mod keeps this session's point: the repo's own .claude/state/resume when the point lives there,
// else the owner's ~/.claude/state/stop-point/points (stop-point's hooks/register.ts, `config`). The panel shows the
// path on top, so a fresh chat can be started from it after a /clear or a dead cache.
import { joinPath, toSlash } from './paths'

/** The places the point may be, the repo's first, as stop-point picks them. */
export function pointCandidates(root: string, home: string, sid: string): string[] {
  if (sid === '') return []
  const out: string[] = []
  if (root !== '') out.push(joinPath(toSlash(root), `.claude/state/resume/${sid}.md`))
  if (home !== '') out.push(joinPath(toSlash(home), `.claude/state/stop-point/points/${sid}.md`))
  return out
}
