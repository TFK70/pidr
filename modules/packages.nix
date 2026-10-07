{ inputs, ... }:
{
  perSystem =
    { system, ... }:
    {
      packages = {
        default = inputs.pi-coding-agent.packages.${system}.default;
      };
    };
}
