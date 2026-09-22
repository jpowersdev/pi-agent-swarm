# pi-agent-swarm

A **Clustered Firecracker Agent** experiment connecting [`effect-pi`](https://www.npmjs.com/package/@jpowersdev/effect-pi), [Effect VFS](https://github.com/lloydrichards/effect-virtual-fs), Git checkpoints, and real [Firecracker](https://firecracker-microvm.github.io/) execution.

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

A real clustered run using `openai-codex/gpt-6-astra`:

1. Loaded the fixture into Effect VFS.
2. Let Pi inspect and edit only through custom VFS tools.
3. Created commit `2e4033673b451fafa17b1ce38ba28a7eb52d7981` in the separate fixture repository.
4. Submitted that exact commit to a durable Effect Cluster execution entity.
5. Booted Firecracker on an executor runner and ran the committed revision's test suite.
6. Returned one passing test through `run_tests`; the complete agent run took about 29 seconds.

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
pnpm demo:cluster-agent
```

`demo:cluster-agent` resets the dedicated fixture repository, starts ephemeral PostgreSQL and two one-VM Cluster runners, and then runs the real Pi session. To run the original direct, single-process path instead:

```sh
pnpm reset:fixture
pnpm demo
```

`prepare:firecracker` downloads the current official Firecracker CI kernel and builds `.data/firecracker/rootfs.ext4` from `node:26-alpine`. The generated kernel and rootfs are ignored by Git.

The demo defaults to the existing `openai-codex/gpt-6-astra` Pi credential. Override model selection if needed:

```sh
SWARM_PROVIDER=... SWARM_MODEL=... pnpm demo:cluster-agent
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
Execution Cluster client
  │ persisted Start(exact commit)
  ▼
Execution entity on a capacity-limited runner
  │ scoped Firecracker process
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

Each runner has an immediate VM-capacity semaphore independent of its larger resident-entity bound. Runner shard weight follows VM capacity, and execution IDs advance through low-discrepancy positions around the shard ring to smooth small bursts without owning placement. One process can host one or many microVMs, and additional runner processes can join the socket cluster without changing callers.

The capacity demonstration starts PostgreSQL, two independent one-VM runner processes, and one synthetic client. It runs six tests, demonstrates two concurrent VMs with excess entities queued, and cancels a seventh running VM:

```sh
nix develop
pnpm demo:cluster
```

The headline `demo:cluster-agent` command uses the same fleet from Pi's `run_tests` tool. Pi receives VFS read/write tools and the semantic test action, never Bash or arbitrary microVM execution.

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
