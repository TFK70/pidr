{
  description = "Pi distribution (pidr)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

    flake-parts = {
      url = "github:hercules-ci/flake-parts";
    };
    import-tree.url = "github:vic/import-tree";
    systems = {
      url = "github:nix-systems/default";
    };
    pi-coding-agent = {
      url = "github:earendil-works/pi";
    };
  };
  
  outputs = inputs: inputs.flake-parts.lib.mkFlake { inherit inputs; } (inputs.import-tree ./modules);
}
