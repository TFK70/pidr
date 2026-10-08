# pidr

`pidr` is a Nix flake distribution of the `pi` coding agent. It wraps the
upstream flake `github:earendil-works/pi` for consumption via Nix and
Nix Home Manager.

## Repository layout

```
flake.nix            # root flake; outputs delegated via import-tree ./modules
flake.lock
extensions/          # pi extensions bundled into the pidr package
  zai-usage.ts       # TUI footer: minimal line + z.ai coding plan usage
modules/
  flake/
    imports.nix      # imports flake-parts modules
    systems.nix      # systems from github:nix-systems/default
  packages.nix       # bundledExtensions list + wrapped `pidr`/default package
  shell.nix          # devShells.default with pi in buildInputs
  home-manager.nix   # homeManagerModules.default: programs.pidr {enable, package, auth}
```

- Language: pure Nix (flake-parts + import-tree). No application code, no
  tests, no CI.
- Inputs: nixpkgs (unstable), flake-parts, import-tree, nix-systems,
  pi-coding-agent.
- The only real logic lives in `modules/packages.nix` (pi wrapped via
  symlinkJoin + wrapProgram with `-e` flags for every entry in
  `bundledExtensions`) and `modules/home-manager.nix`: enabling
  `programs.pidr` installs the pi package and writes `~/.pi/agent/auth.json`
  from `programs.pidr.auth` attrs. The `package` and `auth` options have no
  defaults; consumers must supply them.
- IMPORTANT: new files must be `git add`ed before `nix build` — the flake
  source only contains tracked files, so untracked extensions/modules are
  invisible to Nix.

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
template, skill, or theme — follow this two-step process:

1. **Test on the current pi installation first (dirty changes).** Apply the
   change directly to the live user config (`~/.pi/agent/` — e.g.
   `~/.pi/agent/extensions/`, `~/.pi/agent/prompts/`) or the relevant project
   `.pi/` directory, then verify with the running pi installation that the
   change is valid and works as intended.
2. **Once verified, make the change in this repo** so that future
   installations of pi from pidr include it: package the resource via a Nix
   store path (see "How pi configuration works" above) and load it through
   the flake's bundled-packages mechanism, keeping everything declarative
   and offline-installable.

Do not skip step 1: never land untested pi customizations directly in the
repo.

## Conventions

- Verify Nix changes with `nix build` / `nix flake check` before finishing.
- Keep the repo declarative: nothing that pi downloads or rewrites at
  runtime should become a Nix-managed immutable file, except through the
  explicit bundle/wrapper mechanism described above.
