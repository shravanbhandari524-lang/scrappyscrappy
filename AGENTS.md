## Working rules (always follow)

Context (avoid re-reading):

- At the START of a new session: read summary.md first. Read prd.md and
  architecture.md only if the current task needs them.
- Within the same session, do not re-read these files. Use what is
  already in context.
- Re-read a file only if (a) I tell you I edited it, (b) your context
  was reset or summarized, or (c) you are about to edit it and need its
  exact current content.
- Find the current phase in summary.md and continue from there.

While working (not just at the end):

- Break the current phase into small tasks and add them to summary.md
  as a checklist under the phase.
- Tick each task [x] as soon as it is done and tested, before starting
  the next one.
- Mark the task you are on as [~] (in progress) so another session
  knows where you stopped.
- Add a short log entry after each meaningful step:
  date - what changed - how it was tested - result.
- If something fails or you make a decision (library choice, a changed
  approach, a skipped feature), write it under "Known issues" or
  "Decisions" immediately.

Keeping the docs accurate:

- If the code changes the design (new file, renamed module, new
  endpoint, changed output shape), update architecture.md in the same step.
- If scope changes (feature added, dropped or postponed), update prd.md.
- Docs and code must never disagree. At the end of each phase, compare
  architecture.md against the actual files, routes and output shape,
  and fix any mismatch.

Keeping summary.md short:

- Keep only the last 10 log entries in the "Log" section. Move older
  ones to a "History" section at the bottom.

At the end of each phase:

- Set "Current phase" in summary.md to the next phase.
- Write a 2-3 line summary of what works, what doesn't, and what to do next.
- Stop and report. Do not start the next phase until I say so.

Do not add features, dependencies or files outside the current phase.
