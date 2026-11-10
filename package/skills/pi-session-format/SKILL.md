---
name: pi-session-format
description: Reference for reading pi session transcripts (JSONL under ~/.pi/agent/sessions): entry types, the id/parentId tree, message roles and content blocks, toolCall structure. Use when parsing session files (retrospectives, handoffs, analytics, branching analysis).
---

# Pi session file format

Sessions are JSONL files: one JSON object per line, each with a `type` field. Entries form a **tree** via `id`/`parentId` (branching in place, no new files). Read only — never edit transcript files by hand.

## Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
```

`<path>` is the session's cwd with `/` replaced by `-`. The active branch of the tree is the conversation history. To follow a conversation chronologically, walk from the latest entry up `parentId` links to the root (or read linearly for a no-branch session).

## Entry types (session format v3)

- `session` — header: `{version, id, timestamp, cwd}`; version 3 is current.
- `model_change`, `thinking_level_change` — provider/model/level switches.
- `message` — an `AgentMessage`; the workhorse (see below).
- `toolResult` — `{toolCallId, output}`; pairs with a `toolCall` block by `toolCallId`.
- `custom` — extension-injected entries (was `hookMessage` in v2).

All non-header entries also carry `id`, `parentId`, ISO `timestamp`.

## Message entries

`message` holds `{role, content, ...}`:

- **Roles**: `system`, `user`, `assistant`, `toolResult` (as role on message entries is possible; standalone `toolResult` entries are the norm).
- **`content`** is either a string or an **array of blocks**, each `{type: ...}`:
  - `thinking` — `{thinking}` reasoning text (assistant);
  - `text` — visible text (assistant/user);
  - `toolCall` — `{id, name, arguments}` — a tool invocation. NOTE: the field is **`name`** with **`arguments`** (object), not `function`/`input`;
  - image/audio/resource blocks for media.
- System messages nest prompt parts under `sections` (e.g. `preamble`, `tools`, `skills` as strings) with empty `content`.
- Message `timestamp` inside is Unix ms (entry-level `timestamp` is ISO).

## Parsing tips (jq)

Assume `f` = session file. Inspect structure before assuming shapes:

```sh
# entry type census
jq -r '.type' "$f" | sort | uniq -c
# all tool calls: who called what
jq -r 'select(.type=="message" and .message.role=="assistant")
       | .message.content | if type=="array" then .[]
       | select(.type=="toolCall") | "\(.name) \(.arguments|tojson)" else empty end' "$f"
```

`content` may be a string or array — branch on `type` in every query. Role names live at `.message.role`.

## Authoritative reference

Full spec (kept current with pi):
`<pi package>/docs/session-format.md` and `docs/message-types.md` — resolve the
pi package dir from the running build (e.g. the store path of the pi-coding-agent
package, or `pi config`). This skill is a cache of that spec; when in doubt,
read the source docs.
