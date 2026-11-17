# npm publisher

Atlassian's utility for publishing npm packages from Artifactory and updating dist-tags using OIDC.
`publish-npm.yml` requires Artifactory access and configured GitHub/npm trusted publishing.
[Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) · [Apache-2.0 license](LICENSE)

| Git branch | Protected environment | Default tag for tag operations |
| ---------- | --------------------- | ----------- |
| `main` | `prod` | `latest` |
| `staging` | `staging` | `oidc-test` |
