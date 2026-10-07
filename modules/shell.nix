{ inputs, ... }:
{
  perSystem =
    { system, pkgs, ... }:
    {
      devShells.default = pkgs.mkShell {
        buildInputs = [
          inputs.pi-coding-agent.packages.${system}.default
        ];
      };
    };
}
