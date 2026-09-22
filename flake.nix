{
  description = "pi-agent-swarm development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          curl
          docker-client
          e2fsprogs
          firecracker
          git
          jq
          nodejs_26
          pnpm
          postgresql
        ];
      };
    };
}
