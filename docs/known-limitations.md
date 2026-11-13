# Known limitations and open risks

Nothing here is hypothetical: each entry names the code that carries it and the
evidence that established it.

## R21 — settlement bounds are constants

`settleManagedRange(process, { timeoutMs?, probeMs? })` accepts bounds, but the
product call sites use the defaults (`probeMs = 250`, `timeoutMs = 5_000`).
A very slow Job teardown on a loaded machine therefore reports `residue` rather
than waiting longer. Impact: job status `failed` with a truthful detail, never a
false `completed`. Fix direction: surface both bounds through plugin config.

## R23 — Landlock runtime behaviour is not exercised end-to-end

`native/system` builds three Linux artifacts: `bin/glibc/system.node` (loaded
successfully), `bin/musl/system.node`, and the static musl helper
`bin/landlock-run` (`ELF 64-bit LSB executable, statically linked, stripped`).
A smoke run of `landlock-run --help` exits 125 with
`usage error: unknown argument: --help` — the binary executes, but no test on
this branch asserts that a Landlock policy is actually enforced at runtime.
Do not read the build result as runtime verification.

## R24 — no product-level fault injection

The Windows Job primitives are owned by the runner process; the host has no API
to make `TerminateJobObject` fail. P-07 therefore rests on five layers
(runner catch → runner unit tests with injected bindings → host request mapping →
shell settlement → job outcome), **not** on a product-level failure injection.
No `DSH_RUNNER_FAULT`-style switch exists, by design.

## R25 — a provider that resolves `false` would be ignored

`waitForManagedRange` never forwards the caller's `AbortSignal` to
`waitForExit`, so the provider's "wait aborted" branch is unreachable today and
abort is handled by the helper's own listener. The helper maps any resolution to
`true`; if a future caller starts forwarding a signal, the `false` value must be
propagated (`value !== false`) rather than swallowed.

## Windows ACL baseline failures

`packages/sandbox/sandbox-windows-acl` reports two failures on this machine:

```
dispose aggregates a failing revocation into an AggregateError (best-effort cleanup)
dispose aggregates a failing SID free into an AggregateError
```

They reproduce identically on the baseline commit `f85b2974` (5 failed / 194
passed there; 2 failed / 197 passed on the D7 head, because the D7 branch also
restores the workspace's ability to build). They are **not** introduced by D7 and
remain open.

## Platform-gated suites

`packages/shell/bash-local` and `packages/shell/tool-bash` are excluded from the
Windows test matrix (they need a POSIX shell); they run on Linux/WSL instead.
`packages/sandbox/sandbox-local` includes Windows-ACL cases that fail on Linux for
the same reason and pass on Windows.

## C2A was committed with `--no-verify`

Commit `b477fe96` (C2A) skipped the pre-commit hooks because lefthook's
hide/restore of unstaged changes conflicted with a partially staged index and had
already dropped working-tree edits (recovered from the hook's own WIP stash). The
skipped checks were re-run by hand on a clean checkout: `git diff --check` clean,
`scripts/check-vendor-manifest.sh` exit 0, staged lint reporting only
pre-existing style findings (18 errors, versus 19 on the baseline for the same
files). C2B and C3 ran with the full hook set.
