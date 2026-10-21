# pidr

`pidr` is a Nix flake distribution of the `pi` coding agent. It wraps the
upstream flake `github:earendil-works/pi` for consumption via Nix and
Nix Home Manager.

## Repository layout

```
flake.nix            # root flake; outputs delegated via import-tree ./modules
flake.lock
extensions/          # pi extensions bundled into the pidr package
  pidr-footer.ts      # custom TUI footer: dir | model | think | context | z.ai usage
  pidr-instructions.ts # injects config/AGENTS.md into the system prompt
  pidr-splash.ts      # startup splash: lists active extensions and MCP servers
  claude-bridge.ts    # bridges Claude configs (.mcp.json, CLAUDE.md) into pi
package/             # pi package bundled into pidr (prompt templates)
  prompts/careful.md # /careful — cautious-mode prompt template
modules/patches/     # Nix patches for extensions fetched from upstream repos
config/
  AGENTS.md          # global ~/.pi/agent/AGENTS.md deployed by the home-manager module
modules/
  flake/
    imports.nix      # imports flake-parts modules
    systems.nix      # systems from github:nix-systems/default
  packages.nix       # bundledExtensions list + wrapped `pidr`/default package
  shell.nix          # devShells.default with pi in buildInputs
  home-manager.nix   # homeManagerModules.default: programs.pidr {enable, package, auth, globalInstructions}
```

- Language: pure Nix (flake-parts + import-tree). No application code, no
  tests, no CI.
- Inputs: nixpkgs (unstable), flake-parts, import-tree, nix-systems,
  pi-coding-agent.
- The only real logic lives in `modules/packages.nix` (pi wrapped via
  symlinkJoin + wrapProgram with `-e` flags for every entry in
  `bundledExtensions`) and `modules/home-manager.nix`: enabling
  `programs.pidr` installs the pi package, writes `~/.pi/agent/auth.json`
  from `programs.pidr.auth` attrs, and deploys `~/.pi/agent/AGENTS.md` from
  `programs.pidr.globalInstructions` (defaults to `config/AGENTS.md` in this
  repo). The `auth` option has no default and must be supplied; `package`
is assigned automatically by the module from the flake.
- IMPORTANT: new files must be `git add`ed before `nix build` (see
  Conventions — the flake source contains only tracked files).

## How pi configuration works (important context)

- Pi reads user settings from `~/.pi/agent/settings.json` (mutable — pi
  rewrites it at runtime via `/settings`, `pi pkg add`, etc.) and project
  settings from `.pi/settings.json` (merged on top after project trust).
  There is no managed/policy settings layer, so settings.json must NOT be
  managed as an immutable Nix store path.
- Pi packages (extensions/skills/prompts/themes bundles) can be sourced from
  npm, git, or **local paths**. Local paths are loaded in place, never copied
  or modified, so read-only /nix/store paths work as package sources.
- `-e/--extension` loads a package for one invocation without touching
  settings.json. This is the mechanism used to bundle pi packages in the flake:
  fetch/build each package into the store and wrap the `pi` binary with
  `-e <store-path>` flags via `symlinkJoin` + `wrapProgram`.
- Upstream pi docs are available at
  `/nix/store/*-pi-*/lib/pi/node_modules/@earendil-works/pi-coding-agent/docs/`
  (see `docs/settings.md`, `docs/packages.md`, `docs/configuration.md`,
  `docs/cli.md`).

## Workflow rule: changes to pi's behavior (extensions, prompts, skills, themes, settings)

When asked to add something to pi — e.g. write an extension, add a prompt
template, skill, or theme — make the change declaratively in this repo and
test by building and running the flake. **Never make "dirty" changes to the
global config of the running pi (`~/.pi`)** — any write operation inside
`~/.pi` requires explicit user confirmation; read-only access to `~/.pi` is
allowed.

1. **Make the change in this repo** so that future
   installations of pi from pidr include it: package the resource via a Nix
   store path (see "How pi configuration works" above) and load it through
   the flake's bundled-packages mechanism, keeping everything declarative
   and offline-installable.
2. **Test by building and running the flake** (`nix build` / `nix run`,
   using the wrapped `pidr` binary) — not by mutating the live user config.

Do not skip step 2: never land untested pi customizations.

## Conventions

- Verify Nix changes with `nix build` / `nix flake check` before finishing.
- Git: only read-only commands (`status`, `diff`, `log`) and `git add`
  (required for `nix build` — the flake source contains only tracked
  files) are allowed; anything else needs user confirmation.
- When testing pi - always cleanup test sessions after testing, if any were
  created.
- Keep the repo declarative: nothing that pi downloads or rewrites at
  runtime should become a Nix-managed immutable file, except through the
  explicit bundle/wrapper mechanism described above.

## pidr health checklist

Run this after any change that affects the build or behavior of pidr:
`flake.lock` updates (above all a new pi version), edits to `extensions/`,
`modules/packages.nix` (the `bundledExtensions` list, package versions and
hashes), `modules/home-manager.nix`, `package/`, and patches in
`modules/patches/`. Run only the steps whose components the change edits
or affects — do not run the whole checklist after every minor edit (a
comment fix needs nothing beyond `nix build`; a doc-only change needs
nothing at all). A `flake.lock` bump affects every bundled extension, so
any pi version change requires steps 1–4. Steps go from cheap static checks to expensive
interactive ones; steps 3–6 must be run against the binary from
`nix build` (`result/bin/pi`), not the globally installed `pi`.

### 1. Static checks

```sh
git status --short  # there must be no untracked files that take part in the build
nix flake check     # all outputs: packages, homeManagerModules, all systems
nix build           # builds ./result — the default package (= pidr)
```

Expected results:

- `git status --short` shows no untracked files that should take part in
  the build (see Conventions: untracked files are invisible to Nix).
- `nix flake check` passes without errors.
- `nix build` succeeds; `result/bin/pi` exists (it is the symlinkJoin
  wrapper around pi with `-e` flags for every entry in
  `bundledExtensions`).

### 2. Versions and compatibility

```sh
result/bin/pi --version                    # the pi version built from the current flake.lock
nix flake metadata | grep pi-coding-agent  # the pi-coding-agent rev pinned in flake.lock
```

- Check that the pi version matches the release you bumped `flake.lock`
  to (see `nix flake metadata`).
- Check the bundled package versions in `modules/packages.nix`:
  `pi-subagents` (`version`/`tag`/`hash`; currently v0.80.0) and
  `askuserquestion` (rev `e58609c…`, 1.0.0, patch
  `modules/patches/askuserquestion-prompt-snippet.patch`).
- IMPORTANT: bundled extensions have minimum pi version requirements. When
  updating `flake.lock`, read the extension release notes (e.g.
  pi-subagents: github.com/nicobailon/pi-subagents/releases) and bump their
  versions in `modules/packages.nix` if needed. Historical regression:
  pi 1.2+/1.3 broke background subagent launches (`async: true`) in
  pi-subagents 0.76.1. For that reason, after any pi bump, step 4
  (background subagents) is mandatory.
- An upstream rev change can break patch application — this shows up as a
  failed `nix build` already at step 1.

### 3. Bundled extension loading

One-shot smoke test (does not open the TUI; the `-e` flags load the
packages for a single invocation without touching `settings.json`; API keys
are read from the live `~/.pi/agent/auth.json` — read-only access):

```sh
result/bin/pi -p "Say just: ok"
```

Expected result: `ok` on stdout, exit code 0, and no extension loading
errors in stderr (e.g. `[pidr-instructions] cannot read …` or messages
about a broken pi-subagents npm build).

Every entry of `bundledExtensions` from `modules/packages.nix` must load
without errors:

- `extensions/pidr-footer.ts`;
- `extensions/pidr-instructions.ts`;
- `extensions/pidr-splash.ts`;
- `extensions/claude-bridge.ts`;
- `askuserquestion` (the patched copy pinned to a fixed GitHub revision);
- `pi-subagents` (npm build from a GitHub release);
- `package/` (prompt templates).

The actual list of loaded packages is checked interactively: start
`result/bin/pi` — pidr-splash lists the active extensions and MCP servers
with their connection status at startup. Make sure every name above is in
the list and nothing failed to load.

### 4. pi-subagents functional check (both modes are mandatory)

In an interactive session (`result/bin/pi`), check three scenarios:

1. **Foreground subagent**: "Call the subagent tool in the regular mode
   (no async): have the subagent answer what 2+2 is and return its
   answer." Expected: the tool call succeeds and the subagent's answer
   appears in the session transcript.
2. **Background subagent (`async: true`) + `bg_wait`**: "Launch the same
   subagent with async: true, wait for it to finish via bg_wait and return
   the result." Expected: the run starts in the background, `bg_wait`
   returns the status and the result. This background mode is exactly what
   broke historically (see step 2).
3. **Management calls (status/list)**: "Show the list and status of
   background runs." Expected: the run from step 2 shows up as
   running/completed, with no errors.

After checking, quit with `/quit` — the session must close without
hanging.

### 5. Home-manager module (on a test configuration only)

Never mutate the live `~/.pi`. Verify with a separate test configuration
in /tmp and `home-manager build` (build only, no activation into the live
HOME):

```nix
# /tmp/pidr-hm-test/home.nix
# Substitute the absolute path to this repository in imports.
{ ... }: {
  imports = [ (builtins.getFlake "path:/ABS/PATH/TO/pidr").homeManagerModules.default ];
  programs.pidr = {
    enable = true;
    auth = { example = { apiKey = "test-key"; }; };
  };
}
```

```sh
cd /tmp/pidr-hm-test
nix run github:nix-community/home-manager -- build -f home.nix
```

Expected results (`build` puts the activation package into `./result`):

- `result/home-files/.pi/agent/auth.json` — valid JSON with the attrs from
  `programs.pidr.auth`;
- `result/home-files/.pi/agent/AGENTS.md` — identical to `config/AGENTS.md`
  in this repo (the `programs.pidr.globalInstructions` default);
- the home.packages include the pidr package (`programs.pidr.package` is
  assigned automatically by the module from the flake).

### 6. Repository's custom extensions and prompts

- **pidr-footer** (TUI): start `result/bin/pi` — the custom footer
  `dir | model | think | context | z.ai usage` renders at the bottom; the
  model switches via `/model`, the context counter grows during the
  session, and `/zai-usage` (a command provided by the extension itself)
  shows/refreshes z.ai plan usage.
- **pidr-instructions** (system prompt): `config/AGENTS.md` is injected as
  a `<pidr-global-instructions>` section. Quick one-shot check:
  `result/bin/pi -p "Answer in one word: what language must you reply in?"`
  — expected: "Russian" (the first rule in `config/AGENTS.md` is "Always
  respond in Russian").
- **askuserquestion**: in an interactive session, give an ambiguous task —
  the agent must call the `ask_user_question` tool (the patch declares it
  in the system prompt; the rule to call it on ambiguity lives exactly in
  `config/AGENTS.md`, so this check also covers pidr-instructions).
- **/careful** (prompt template from `package/`): type `/careful` in the
  TUI — the command appears in autocompletion (with the description from
  `package/prompts/careful.md`) and the template expands into cautious
  mode.
- **claude-bridge** (optional, in a project with Claude configs): in a
  directory with `.mcp.json`/`.claude/`, splash lists the registered MCP
  servers; `CLAUDE.md` reaches the system prompt.

### 7. Testing rules (hygiene)

- Never mutate `~/.pi` directly: any writes inside `~/.pi` require explicit
  user confirmation; read-only access is allowed.
- Always run tests via `result/bin/pi` from `nix build` (the wrapper with
  bundled `-e` flags), not via the global `pi`.
- Verify home-manager only by building the test configuration (step 5),
  without activating it into the live HOME.
- After interactive tests, delete the test sessions from
  `~/.pi/agent/sessions` (find them by test time); leave no garbage.
