# askuserquestion (vendored)

Adds an `ask_user_question` tool to pi: the model pauses mid-task, asks
1–4 clarifying questions in a structured TUI (single/multi-select with an
always-available free-text "Other"), and continues with the user's answers
instead of guessing.

Vendored from <https://github.com/ghoseb/pi-askuserquestion> (MIT, © ghoseb)
at commit `e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578` (branch `main`).
Only runtime files are kept (`src/` + this manifest). Upstream tests,
linting config, and dev tooling live in the original repository.

## Local modifications

`src/index.ts` registers the tool with `promptSnippet` and `promptGuidelines`
so pi's default system prompt lists the tool in its "Available tools" section
and carries explicit "ask instead of guess" guideline bullets. Upstream relies
on the tool description alone; without `promptSnippet`, custom tools are
omitted from that section of the default prompt.

No other changes. The TUI component, schemas, and validation are verbatim
copies of upstream.

## Loading

Bundled by the pidr flake via the `bundledExtensions` wrapper mechanism
(`pi -e <store-path>/extensions/askuserquestion`), so no settings.json entry
is needed. Runtime imports are limited to pi host-provided packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`);
there are no runtime dependencies.

In non-interactive sessions (print/JSON mode) the tool disables itself and
tells the model to proceed with its best judgment.
