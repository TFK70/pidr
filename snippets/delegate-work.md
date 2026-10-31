---
name: Delegate work
description: Delegate implementation to worker subagents for this message
placement: append
order: 40
---
Delegate implementation to worker subagents for this message — they write and edit the code, not you — keeping your own context lean for planning, review, and aggregation. Give each worker a complete, self-contained task packet (objective, repo/working directory, constraints, relevant files, success criteria), run independent workers in parallel while sequencing dependent steps yourself, then review and integrate their results: check the diffs, run the checks, and report a final summary.
