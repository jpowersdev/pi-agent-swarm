# Firecracker executor notes

These notes record the primary-source facts used by the experiment.

## Host and launch requirements

Firecracker requires Linux on x86-64 or aarch64 and read/write access to `/dev/kvm`. Its getting-started guide presents direct execution without the jailer only as a demonstration and states that production deployments are intended to use the jailer.

Source: [Firecracker Getting Started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md#prerequisites)

A microVM needs an uncompressed guest kernel and a root filesystem image. The official guide publishes commands for discovering current CI kernel artifacts from `spec.ccfc.min`; `scripts/prepare-firecracker` follows that discovery mechanism while constructing its own Node root filesystem.

Source: [Getting a rootfs and Guest Kernel Image](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md#getting-a-rootfs-and-guest-kernel-image)

## Why workspace state is not a VM snapshot

A Firecracker snapshot records guest memory and emulated hardware state. Disk files are managed separately by the user. Snapshot restoration can share read-only disks, which supports keeping the toolchain/rootfs stable while attaching separate workspace state.

Source: [Firecracker Snapshotting — Overview](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md#overview)

The current experiment does not yet use memory snapshots. It boots a stable read-only rootfs and attaches a fresh ext4 drive containing one Git commit. This keeps the workspace as a data layer instead of conflating it with VM state.

## Security boundary in this experiment

No network interface is configured. The guest receives only:

- a read-only root filesystem containing Node;
- a writable workspace block device generated from one Git commit;
- one vCPU and 512 MiB of memory;
- a serial console for the test result.

The direct Firecracker process is not a complete production deployment. The official guidance calls for the jailer, and a real service must additionally control host users, cgroups, seccomp policy, artifact integrity, execution time, and output size.
