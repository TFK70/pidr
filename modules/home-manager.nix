{ self, ... }:
{
  flake.homeManagerModules.default =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (pkgs.stdenv.hostPlatform) system;
    in
    {
      options.programs.pidr = {
        enable = lib.mkEnableOption "pidr";
        package = lib.mkOption {
          type = lib.types.package;
        };
        auth = lib.mkOption {
          type = lib.types.attrs;
        };
        globalInstructions = lib.mkOption {
          type = lib.types.lines;
          description = ''
            Contents of ~/.pi/agent/AGENTS.md — global user instructions
            applied by pi to every session and project. Defaults to the
            bundled config/AGENTS.md from this repository.
          '';
          default = lib.fileContents "${self}/config/AGENTS.md";
        };
      };
      config = {
        programs.pidr.package = self.packages.${system}.default;
        home.packages = lib.mkIf config.programs.pidr.enable [ config.programs.pidr.package ];
        home.file = {
          ".pi/agent/auth.json".source = pkgs.writeText "auth.json" (lib.generators.toJSON {} config.programs.pidr.auth);
          ".pi/agent/AGENTS.md".source = pkgs.writeText "AGENTS.md" config.programs.pidr.globalInstructions;
        };
      };
    };
}
