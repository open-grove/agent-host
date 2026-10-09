# Agent Host

Read `README.md`, `docs/scope.md` and `docs/kernel-support.md` before changing public boundaries.

- This repository extracts native Agent integration from OpenGrove. Preserve source attribution and license notices when moving code.
- Keep OpenGrove business objects out of public contracts and runtime dependencies.
- Preserve native model loops, tools, sessions and permission semantics. Do not rebuild those behaviors in the Host.
- Reuse existing adapters and tests where appropriate. Review referenced unmerged work before depending on it; do not silently treat it as merged.
- Track substantive implementation in public issues before changing code.
- Declare capabilities only with an implementation path and evidence. Keep protocol/mock tests distinct from native probes.
- Test distributable archives from an independent consumer, not only repository-relative imports.
- Separate extraction regressions from upstream upgrade regressions in commits and validation.
- Do not commit credentials, private conversations, machine-local state or raw diagnostic recordings.
- For documentation-only changes, check local links and `git diff --check`. Runtime validation commands must be documented when executable packages are introduced.
