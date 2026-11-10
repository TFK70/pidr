---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. If you need to re-read earlier parts of the session from its transcript (`~/.pi/agent/sessions/`), load the `pi-session-format` skill first. Save the handoff to the temporary directory of the user's OS (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should invoke (via `/skill:<name>`).

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

<!-- Ported from Matt Pocock's `skills` repo (MIT): skills/productivity/handoff @ 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d. https://github.com/mattpocock/skills -->
