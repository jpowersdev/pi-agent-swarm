# pi-agent-swarm

A deliberately narrow experiment connecting [`effect-pi`](https://www.npmjs.com/package/@jpowersdev/effect-pi), [Effect VFS](https://github.com/lloydrichards/effect-virtual-fs), Git checkpoints, and real [Firecracker](https://firecracker-microvm.github.io/) execution.

One Pi session receives only five tools:

- `list_directory`
- `read_file`
- `write_file`
- `edit_file`
- `run_tests`

The first four operate on a private Effect VFS overlay. `run_tests` materializes that overlay into the adjacent fixture repository, creates a real Git commit, constructs a commit-specific ext4 workspace drive, boots a networkless Firecracker microVM, and runs `node --test` there. Pi has no Bash tool and the guest has no model credentials.

This is an experiment, not a reusable library or production sandbox.

## What the demo proves

The included fixture starts with this bug:

```js
export const add = (left, right) => left - right
```

A real run using `openai-codex/gpt-6-astra`:

1. Loaded the fixture into Effect VFS.
2. Let Pi inspect and edit only through custom VFS tools.
3. Created commit `881ba0114ed46de0e62a4512d563a3b350a2dc0d` in the separate fixture repository.
4. Booted Firecracker and ran the committed revision's test suite.
5. Reported one passing test in roughly 0.9 seconds from checkpoint through guest shutdown.

The commit changed only `src/add.js`. No host Bash tool was exposed to the model.

## Repositories

The application expects these sibling directories:

```text
jpowersdev/
├── effect-pi/
├── pi-agent-swarm/
└── pi-agent-swarm-fixture/
```

`pi-agent-swarm-fixture` is a separate Git repository. Its `baseline` tag identifies the deliberately failing initial state. `pnpm reset:fixture` discards all later fixture commits and returns it to that tag.

## Requirements

- x86-64 Linux with readable/writable `/dev/kvm`
- Docker daemon access (used only to assemble the guest root filesystem)
- Nix with flakes
- Existing Pi credentials at `~/.pi/agent/auth.json`
- Node.js 26 and pnpm 11.25.0

The Nix shell supplies Firecracker, `mke2fs`, PostgreSQL, Docker CLI, Node, pnpm, Git, curl, and jq.

## Run

```sh
nix develop
pnpm install --frozen-lockfile
pnpm prepare:firecracker
pnpm reset:fixture
pnpm demo
```

`prepare:firecracker` downloads the current official Firecracker CI kernel and builds `.data/firecracker/rootfs.ext4` from `node:26-alpine`. The generated kernel and rootfs are ignored by Git.

The demo defaults to the existing `openai-codex/gpt-6-astra` Pi credential. Override model selection if needed:

```sh
SWARM_PROVIDER=... SWARM_MODEL=... pnpm demo
```

Normal checks do not require KVM or make model requests:

```sh
pnpm check
pnpm test
```

## Architecture

```text
Pi Session
  │ custom tools only
  ▼
Effect VFS overlay
  │ checkpoint before run_tests
  ▼
Separate Git fixture repository
  │ immutable commit
  ▼
Commit-specific ext4 workspace drive
  │ attached as /dev/vdb
  ▼
Fresh Firecracker microVM
  │ node --test
  ▼
Structured PASS/FAIL result returned to Pi
```

The root filesystem is read-only and reused. The workspace drive is writable and discarded after the invocation. There is no guest network device.

### Cluster execution fleet

Every test invocation is an Effect Cluster entity addressed by its execution ID. The entity owns the scoped Firecracker fiber; completion, cancellation, shard movement, and runner shutdown all clean up that resource. Persisted `Start` messages provide durable queuing, while an idempotent `queued → running` transition prevents replay from launching a second VM.

Each runner has an immediate VM-capacity semaphore independent of its larger resident-entity bound. One process can host one or many microVMs, and additional runner processes can join the socket cluster without changing callers.

The real cluster demonstration starts PostgreSQL, two independent one-VM runner processes, and one client. It runs six tests, demonstrates two concurrent VMs with excess entities queued, and cancels a seventh running VM:

```sh
nix develop
pnpm demo:cluster
```

See [`docs/cluster-executions.md`](docs/cluster-executions.md) for the implemented lifecycle and [`docs/distributed-executor.md`](docs/distributed-executor.md) for workspace transport, caching, and the platform-neutral scaling direction.

## Intentional shortcuts

- The fixture supports ordinary UTF-8 files and directories, not arbitrary Git modes or symlinks.
- The current executor creates a full commit-specific workspace drive. Git still records only changed blobs, but cross-machine delta transport is future work.
- It cold-boots from a kernel/rootfs instead of restoring a prepared Firecracker memory snapshot.
- The Cluster proof uses local processes, local KVM, and ephemeral PostgreSQL; it has not yet been exercised across machines.
- Firecracker is launched directly rather than through its production `jailer`.
- The fixture has no third-party dependencies. A real codebase needs a toolchain/dependency layer keyed by an image digest.
- Build/test code should be treated as hostile even though the model cannot invoke arbitrary Bash.

## Version compatibility

`effect-pi@0.1.0` uses Effect `4.0.0-rc.116`. Published `@effect-vfs/core@0.4.0` still declares an exact `rc.114` peer. This project allows the peer override and has exercised VFS fixture loading, overlays, editing, capture, and checkpointing on `rc.116`. Remove the override when Effect VFS publishes matching metadata.

See [`docs/firecracker-executor.md`](docs/firecracker-executor.md) for the primary-source constraints behind the guest design, and [`docs/distributed-executor.md`](docs/distributed-executor.md) for the intended cached, delta-driven executor direction.
