# npm publisher

Publish npm artifacts or update distribution tags through GitHub-hosted OIDC.
`publish-npm.yml` handles both stages and accepts any valid package name with
npm trusted-publisher authorization.

| Git branch | Protected environment | Default tag for tag operations |
| ---------- | --------------------- | ----------- |
| `main` | `prod` | `latest` |
| `staging` | `staging` | `oidc-test` |
