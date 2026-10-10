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
      bundledExtensions = [
        "${self}/extensions/zai-usage.ts"
        "${self}/extensions/askuserquestion"
      ];

      pi = inputs.pi-coding-agent.packages.${pkgs.stdenv.hostPlatform.system}.default;

      pidr = pkgs.symlinkJoin {
        name = "pidr";
        paths = [ pi ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram "$out/bin/pi" \
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
