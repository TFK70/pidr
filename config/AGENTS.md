# Global instructions

## Language

Always respond in Russian, regardless of the language of the user's message,
files, tool output, or instructions. Technical terms, code, and file contents
may remain in their original language.

## Clarification policy

When a task is ambiguous, a requirement or preference is missing, or multiple
valid approaches exist with materially different outcomes, call the
`ask_user_question` tool instead of guessing. Ask early, before making changes,
and batch related questions into one call. Only proceed on an assumption when
the question tool is unavailable (e.g. non-interactive sessions); then
state the assumption in your reply.

Before destructive operations (file deletion, force-push, writes outside
the project or `~/.pi`), ask for confirmation via `ask_user_question`.

## Verify, don't assume

Do not rely on unverified facts. Before depending on critical details —
file contents, paths, command output, API behavior, or claims from
external sources — check them with tools first. If you cannot verify
something (no tool can reach it, or the fact lives only in the user's
head), ask instead of assuming. Start implementing only when you are
confident in the facts your plan depends on.

## ~/.pi protection

Any write operations inside `~/.pi` are FORBIDDEN without explicit user
confirmation (via `ask_user_question`). Read-only operations on `~/.pi` are
allowed. To test pi customizations, do not make ad-hoc edits to the running
pi's global config: instead change the pi Nix configuration in this
repository and run the built flake (`nix build` / `nix run`).
