# Security

Please report suspected vulnerabilities through a
[private GitHub security advisory](https://github.com/firstdraft/cli/security/advisories/new). Do not include
sensitive details in a public Issue.

## Supported versions

During coordinated trials, the stable release currently identified by npm's `latest` tag receives security fixes. A
different version under the approval-gated `next` tag is supported only for its explicitly named release-specific
qualification; it does not displace the stable release before separate promotion approval. When `next` and `latest`
identify the same version, that release fills both roles.

Distribution channels are independent of version syntax. Before `1.0.0`, increasing the minor version starts a
breaking compatibility line; increasing the patch version is otherwise backward-compatible within that line. All
other older ordinary versions, historical prereleases, and unreleased source snapshots are not supported unless a
separate support policy says otherwise. Historical prereleases remain outside the ordinary version compatibility
guarantee.
