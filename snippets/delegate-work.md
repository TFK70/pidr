---
name: Delegate work
description: Delegate implementation to worker subagents for this message
placement: append
order: 40
---
Delegate implementation to worker subagents for this message — they write and edit the code, not you. Keep your own context window lean for planning, review, and aggregation.

Give each worker a complete, self-contained task packet:
- Objective — what to implement and the expected outcome.
- Repo and working directory, so the worker starts in the right place.
- Constraints — conventions, scope limits, commands not to run.
- Relevant files and entry points to read or edit.
- Success criteria — how the worker verifies the result (tests, build).

Run independent workers in parallel; sequence dependent steps yourself, launching each only after its prerequisite finishes. Review and integrate results yourself: check the diffs, run the checks, and report a final summary.
