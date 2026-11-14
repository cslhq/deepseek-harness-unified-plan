# DeepSeek Harness — unified D1–D7 branch

English | [中文](README.zh.md)

> **Unofficial personal development branch.** Maintained by [@cslhq](https://github.com/cslhq), forked from [DeepSeek-ai/DeepSeek-Harness](https://github.com/DeepSeek-ai/DeepSeek-Harness) at tag `dsh-v0.2.2-rc.1`. It is not an official DeepSeek release and carries no endorsement from DeepSeek.

## What this branch is about

A process is not finished when its root exits. On Windows a command runs inside a Job object, and on POSIX inside a process group; both can outlive the process you started. Treating "the root exited" as "everything is cleaned up" is how orphaned workers, locked temp directories and half-released ACL grants accumulate.

This branch makes the lifecycle explicit end to end: reliable cleanup, single ownership of every resource, observation of the managed process range, termination of that range, and a final settlement that refuses to report success it cannot prove.

## D1–D7 at a glance

| Stage | Owner package | Responsibility |
| --- | --- | --- |
| D1 | `dsh-sandbox-windows-acl` | Idempotent `AclWriteGrant` disposal; on failure the SID is retained so the grant can be retried |
| D2 | `dsh-sandbox-local` | Reference-counted resource leases; the last holder releases the shared resource |
| D3 | `dsh-sandbox-local` | Session drain state machine: `open → draining → drained / residue` |
| D4 | `dsh-sandbox-windows-acl` | `ResidueLedger` records releases that were never confirmed, so they can be retried |
| D5 | `dsh-sandbox-local` | `QuarantineStore` persists quarantined resources with atomic writes and retry state |
| D6 | `dsh-shell` | The `ShellProcess.waitForExit` contract: observation only, never termination |
| D7 | `dsh-win32-process`, `dsh-subprocess-local`, `dsh-shell`, `dsh-tool-*` | Windows Job ownership, `terminateRange` / `verifyRange`, `settleManagedRange`, job settlement |

## Core invariants

- **Root process `done` ≠ managed range empty.** `ShellProcess.done` settles with the direct process only; descendants may still be alive inside the Job.
- **`verifyRange` observes only.** It re-reads the range and reports what the runner could prove; it never terminates anything.
- **`terminateRange` requests termination.** It asks the runner to terminate whatever the range still holds and reports the resulting state.
- **`waitForExit` waits for the range to empty.** It never terminates; `false` means this wait was cancelled, `reject` means the range cannot be observed.
- **`drained` vs `residue`.** Only a proven-empty range is `drained`; anything unproven is `residue`, and `residue` maps to a `failed` job — never to `completed`.

## Run from source

```bash
git clone --branch audit/d7-r2-integration --single-branch https://github.com/cslhq/deepseek-harness-unified-plan.git
cd deepseek-harness-unified-plan
corepack enable
corepack prepare pnpm@11.28.5 --activate
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

Requirements: Node.js `>=24.9.0` (this branch was tested on 24.19.0) and pnpm 11.28.5. The Web UI listens on `http://127.0.0.1:3080`; `pnpm run build` builds packages and Web artifacts, and does not install a Windows desktop application.

## Run

The published npm package runs the official release and does not contain the D1–D7 changes in this repository:

```bash
npx @deepseek-ai/dsh web
```

Desktop builds are a separate Electron pipeline (`pnpm run package:desktop`), not part of the source workflow above.

## Validation status

| Check | Result |
| --- | --- |
| Windows `pnpm run typecheck` | 5 / 5 gates |
| Windows `pnpm run build:artifacts` | 8 / 8 gates |
| Windows package tests | win32-process 83, subprocess-local 225 (+19 skipped), shell 26, pwsh-local 47 (+1 skipped), tool-pwsh 161 |
| Linux / WSL bash suites | 9 / 9 files |
| Linux native build | `build:ts` and `build:native` exit 0; glibc `system.node` loads |
| `sandbox-windows-acl` | 2 failed / 197 passed — both failures reproduce on the pre-D7 baseline |

The full record, including the reproduce commands, is in [docs/validation/d7-r2-final-acceptance.md](docs/validation/d7-r2-final-acceptance.md).

## Known limitations

- **R21** — `settleManagedRange` probe and proof bounds are constants (250 ms / 5 s); a very slow teardown reports `residue` instead of waiting longer.
- **R23** — the Landlock helper builds and executes, but no test asserts that a Landlock policy is enforced at runtime.
- **R24** — there is no product-level fault-injection switch; P-07 rests on five layers of evidence rather than a real `TerminateJobObject` failure.
- **R25** — `waitForManagedRange` ignores a provider that resolves `false`; safe today because the signal is never forwarded, and it must be revisited if that changes.
- **Windows ACL baseline failures** — `dispose aggregates a failing revocation` and `dispose aggregates a failing SID free` fail identically before D7 and remain open.
- **P-07 is layered evidence** — do not read it as a completed product-level injection.
- **Landlock build success** — a green native build is not runtime policy verification.

All of the above are tracked in [docs/known-limitations.md](docs/known-limitations.md).

## Contributing

This is a personal development branch. [CONTRIBUTING.md](CONTRIBUTING.md) keeps the upstream body and appends the branch note here; the upstream rules describe how the official project accepts changes, which is not what this repository does.

- Issues filed at [this repository's tracker](https://github.com/cslhq/deepseek-harness-unified-plan/issues) are tracked here only; they are not forwarded to the upstream project.
- Pull requests are accepted at the maintainer's discretion; nothing opened here is transferred to, or merged into, the official DeepSeek Harness repository.
- Whether the upstream project accepts an external pull request is decided by that project, not by this branch.

## Citation

If you cite DeepSeek Harness, use the upstream entry rather than this branch:

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

The D1–D7 changes live only in [this repository](https://github.com/cslhq/deepseek-harness-unified-plan) on branch `audit/d7-r2-integration`; they have no separate publication, DOI or citation entry.

## License

The repository keeps the upstream MIT [LICENSE](LICENSE), including the copyright notice it already carries; third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This branch adds no separate copyright notice for the D1–D7 changes, and this README makes no claim about their authorship or ownership.

## Documentation

- [docs/README.md](docs/README.md) — documentation index for this branch
- [docs/architecture/d1-d7-overview.md](docs/architecture/d1-d7-overview.md) — how D1–D7 fit together
- [docs/architecture/windows-job-runner-lifecycle.md](docs/architecture/windows-job-runner-lifecycle.md) — Job ownership and the runner protocol
- [docs/architecture/shell-managed-range-contract.md](docs/architecture/shell-managed-range-contract.md) — `waitForExit` / `terminateRange` / `verifyRange`
- [docs/development/windows.md](docs/development/windows.md) — building and testing on Windows
- [docs/development/linux-wsl.md](docs/development/linux-wsl.md) — building and testing on Linux / WSL
- [docs/known-limitations.md](docs/known-limitations.md) — open risks and baseline failures

Chinese translations sit next to every page (`*.zh.md`).
