# Documentation index — unified D1–D7 branch

This directory documents the **unofficial personal fork** that carries the
D1–D7 process-lifecycle work. Upstream documentation under this tree is kept
unchanged; the pages below are additions.

| Page | What it answers |
| --- | --- |
| [architecture/d1-d7-overview.md](architecture/d1-d7-overview.md) | What D1–D7 each own, and how they fit together |
| [architecture/windows-job-runner-lifecycle.md](architecture/windows-job-runner-lifecycle.md) | How a Windows Job object is created, owned, observed, and closed |
| [architecture/shell-managed-range-contract.md](architecture/shell-managed-range-contract.md) | `waitForExit` / `terminateRange` / `verifyRange` semantics |
| [development/windows.md](development/windows.md) | Building and testing on Windows |
| [development/linux-wsl.md](development/linux-wsl.md) | Building and testing on Linux / WSL, including the native addon |
| [validation/d7-r2-final-acceptance.md](validation/d7-r2-final-acceptance.md) | The acceptance run behind this branch's HEAD |
| [known-limitations.md](known-limitations.md) | Open risks R21/R23/R24/R25 and known baseline failures |

## Scope and honesty rules

- Every number on these pages comes from a recorded run on this branch; nothing
  is projected or estimated.
- Where evidence is layered (unit + protocol + product) rather than end-to-end,
  the page says so explicitly.
- `CONTRIBUTING.md` is **not** modified: it remains the upstream document. Local
  conventions for this fork are recorded in this index and in
  [development/windows.md](development/windows.md).
