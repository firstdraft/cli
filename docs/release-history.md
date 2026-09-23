# First Draft CLI release history

This page preserves dated release and registry observations. It is historical evidence, not a statement of current
npm, GitHub, service, or qualification state. Before acting, recheck the registry, protected tags, exact source SHA,
compatibility declarations, trusted-publisher relationship, and named release-specific qualification by following
the living [release policy and runbook](../RELEASING.md).

## 0.4.0 local-output release

- On September 23, 2026 UTC, protected tag `v0.4.0` published CLI `0.4.0` from
  `a555f8d39862109b8c28b392c0439470e88f4ba8` directly to `latest` through
  [GitHub trusted publishing](https://github.com/firstdraft/cli/actions/runs/35807891432).
- `plan compile` now defaults to current-folder output, equivalent to `--output .`. GitHub Publication requires
  `--github`. API compatibility remains `0.4.x`; this is a breaking CLI-default change from `0.3.x`.
- npm SHA-1 is `65b6b960b9029cb8f2352273db9fb551132f2ac9`. Public exact-version installation reported `0.4.0`, and
  registry signature and provenance verification passed. `latest` selected `0.4.0`; `next` remained `0.3.0`.
- The packed candidate compiled a reviewed Reading List Plan against service `2bfdf6bf`, materialized 360 files at
  the local root, and passed local Rails boot, browser creation, and source-edit refresh. Existing warnings and gaps
  remained disclosed. No Codespace, GitHub Publication, native build, or Revyl session was part of this release smoke.
- Plugin `0.4.0` bundles this exact CLI source. Its publication workflow matched all 27 files with the registry CLI.
  The [plugin release record](https://github.com/firstdraft/skills/blob/main/evidence/2026-09-22-plugin-0.4.0-release.md)
  records the companion package, catalog, and post-publication Drawing Board follow-up.

## 0.1.0 alpha publications

- On July 31, 2026, npm rejected the unscoped `firstdraft` name for `v0.1.0-alpha.1` as too similar to the existing
  `first-draft` package before creating a registry package. The tag records the first reviewed release candidate and
  is immutable; neither its tag nor version may be moved or reused.
- On August 5, 2026, `v0.1.0-alpha.2` became the first organization-scoped publication,
  `@firstdraft.com/cli@0.1.0-alpha.2`.
- As observed earlier on August 7, 2026, `0.1.0-alpha.2` was the only published scoped version and both npm's `next`
  and `latest` dist-tags identified it.

## 0.1.0 ordinary release and promotion

- Later on August 7, 2026, protected tag `v0.1.0` published ordinary version `0.1.0` under `next`, while `latest`
  continued to identify `0.1.0-alpha.2`. The ordinary release intentionally superseded the alpha and required the
  service's `0.2.x` API contract; the historical prerelease did not define an ordinary compatibility line.
- The first ordinary release established the npm trusted-publisher relationship used by the release workflow.
- On August 12, 2026, the selected bounded CLI `0.1.0` user-journey smoke passed and separate promotion approval was
  granted. `latest` was promoted to `0.1.0`; both `next` and `latest` then identified ordinary version `0.1.0`. Full
  v14 service qualification remained separate and incomplete.
- Requiring two-factor authentication while disallowing tokens at the package publishing-access layer was not a
  `v0.1.0` release prerequisite and was not established by that release evidence.

The alpha versions remain immutable registry history but, as of the August 12 observation, neither distribution
channel selected them. Protected tag `v0.1.0` and package version `0.1.0` were consumed and immutable. Preparing
source or documentation does not mutate either dist-tag.

## 0.2.0 candidate publication

- On August 27, 2026, protected tag `v0.2.0` published ordinary version `0.2.0` under `next`; `latest` remained
  `0.1.0`. The candidate established compatibility with API contract `0.3.x` but did not displace the separately
  promoted stable release.
- Package version `0.2.0` and protected tag `v0.2.0` are consumed and immutable. A backward-compatible addition to
  the `0.2.x` line therefore requires a higher patch version rather than reusing those identities.

## 0.2.1 candidate publication

- On August 28, 2026, protected tag `v0.2.1` published ordinary version `0.2.1` under `next`; `latest` remained
  `0.1.0`. The patch hardened direct Compilation recovery while preserving the `0.2.x` compatibility line.
- Package version `0.2.1` and protected tag `v0.2.1` are consumed and immutable. As observed on August 29, 2026,
  current-directory root-output had integrated to `main` at `4352f64baf673ad93457e8bc84273e9d1d9a9501` (tree
  `b43ba6de98e27328e548cc3410ba9f39dfa9fcee`) but was not part of those registry bytes.

## 0.2.2 publication and registry observation

- The [npm registry](https://registry.npmjs.org/@firstdraft.com%2fcli) records version `0.2.2` published at
  `2026-08-30T04:40:13.459Z`.
  [Tag `v0.2.2`](https://github.com/firstdraft/cli/releases/tag/v0.2.2) resolves to
  `799a184cb2453ceadf5575f7b46ba975e084f192`. That source implements current-root adoption with the archive at
  top-level `design/`.
- On September 18, 2026, a read-only registry check found both `next` and `latest` selecting `0.2.2`. This is an
  observation of their selection, not evidence of the time or approval of the earlier promotion. The check ran no
  fresh package parity, service, authenticated user-journey, or Codespaces qualification.
- Package version `0.2.2` and protected tag `v0.2.2` are consumed and immutable. The nested `.firstdraft/design`
  archive belongs to the unpublished `0.3.0` source candidate; preparing it does not change installed `0.2.2` bytes.
