# Bundled pi extensions.
#
# Extensions listed here are shipped from the repo (loaded straight from the
# Nix store via `-e <path>` flags on the wrapped `pi` binary). Local extension
# files are loaded in place by pi, so read-only store paths are fine and no
# settings.json entries are needed.
#
# Workflow rule: an extension must first be verified against the current pi
# installation (e.g. in ~/.pi/agent/extensions/) before it is added here.
{ self, inputs, lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      # pi-subagents extension, built from the upstream GitHub release.
      # buildNpmPackage resolves the full dependency tree from the upstream
      # package-lock.json (single npmDepsHash), compiles TypeScript and we
      # prune devDependencies, so nothing is vendored in this repo.
      pi-subagents = pkgs.buildNpmPackage {
        pname = "pi-subagents";
        version = "0.80.0";
        src = pkgs.fetchFromGitHub {
          owner = "nicobailon";
          repo = "pi-subagents";
          tag = "v0.80.0";
          hash = "sha256-/XjtoCIQu1c0DwOM+aeWWBmyk7JFuQWB10o9RLJk/kU=";
        };
        npmDepsHash = "sha256-tE3uoRQZ0L0GYQDv3AwsvrAZSEAObQVl/DJ50sM4thA=";
        npmDepsFetcherVersion = 2;

        # scripts/build-package.mjs compiles TS into dist-pkg/ (the package
        # layout that is published to npm).
        npmBuildScript = "build:pkg";

        installPhase = ''
          runHook preInstall
          # Drop devDependencies, keep only runtime deps in node_modules.
          npm prune --omit=dev
          mkdir -p "$out"
          cp -r dist-pkg/. "$out"/
          cp -r node_modules "$out"/node_modules
          runHook postInstall
        '';
      };

      # askuserquestion extension from the upstream GitHub repo. Upstream
      # ships pure TypeScript with no runtime dependencies, so no npm build
      # is needed; the only pidr-specific tweak (promptSnippet/promptGuidelines
      # so the tool is listed in the default system prompt) is carried as a
      # patch instead of a vendored copy.
      askuserquestion = pkgs.stdenv.mkDerivation {
        name = "pi-askuserquestion-1.0.0";
        src = pkgs.fetchFromGitHub {
          owner = "ghoseb";
          repo = "pi-askuserquestion";
          rev = "e58609c9e9c8c4e8a0348c96eaad38dd7e6f0578";
          hash = "sha256-F++LjTMMc9XAQZ3ZAvuTXK/e8kvszGDde5/uLgh+Vw8=";
        };
        patches = [ ./patches/askuserquestion-prompt-snippet.patch ];
        installPhase = ''
          cp -r . "$out"
        '';
      };

      bundledExtensions = [
        "${self}/extensions/pidr-footer.ts"
        "${self}/extensions/pidr-instructions.ts"
        "${self}/extensions/pidr-splash.ts"
        "${self}/extensions/claude-bridge.ts"
        askuserquestion
        pi-subagents
        "${self}/package"
      ];

      pi = inputs.pi-coding-agent.packages.${pkgs.stdenv.hostPlatform.system}.default;

      pidr = pkgs.symlinkJoin {
        name = "pidr";
        paths = [ pi ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram "$out/bin/pi" \
            --set PIDR_REV "${self.rev or self.dirtyRev}" \
            --add-flags "${lib.concatMapStringsSep " " (e: "-e ${e}") bundledExtensions}"
        '';
        meta.mainProgram = "pi";
      };
    in
    {
      packages = {
        pidr = pidr;
        default = pidr;
      };
    };
}
