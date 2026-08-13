# First Draft CLI release history

This page preserves dated release and registry observations. It is historical evidence, not a statement of current
npm, GitHub, service, or qualification state. Before acting, recheck the registry, protected tags, exact source SHA,
compatibility declarations, trusted-publisher relationship, and named release-specific qualification by following
the living [release policy and runbook](../RELEASING.md).

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
