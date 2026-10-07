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
      };
      config = {
        programs.pidr.package = self.packages.${system}.default;
        home.packages = lib.mkIf config.programs.pidr.enable [ config.programs.pidr.package ];
        home.file = {
          ".pi/agent/auth.json" = pkgs.writeText "auth.json" (lib.generators.toJSON {} config.programs.pidr.auth)
        };
      };
    };
}
