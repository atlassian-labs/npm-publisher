# Artifactory npm publisher

Publish npm artifacts or update distribution tags through GitHub-hosted OIDC.
Both workflows accept any valid package name with npm trusted-publisher authorization.

| Stage      | Workflow                              | Protected environment | Default tag |
| ---------- | ------------------------------------- | --------------------- | ----------- |
| Production | `publish-npm.yml`    | `npmjs-prod`          | `latest`    |
| Staging    | `publish-artifactory-npm-staging.yml` | `npmjs-staging`       | `oidc-test` |

Both use `ubuntu-latest` and `main`, and write to the real npmjs registry.
Use dedicated test packages for staging.

For `publish`, exchange a GitHub ID token for a temporary Artifactory credential,
download the original tarball, and read its manifest using the pinned npm CLI's
bundled `pacote`. Check the effective package name/version, top-level tag and
`publishConfig`, then run `npm publish` once with `--ignore-scripts`,
`--provenance` and public access. Package lifecycle scripts do not run.

Tag operations call `npm dist-tag` directly and skip the artifact download.
The npm CLI obtains its own npm OIDC credentials; Artifactory credentials are
used only for downloading. No static npm or Artifactory token is needed.

## Setup

1. Protect `main`, require **Check publisher**, and require owner review for
   workflows, helpers and the lockfile. Give the caller's GitHub App access to
   this repository with **Actions: write** for API dispatch.
2. Create the two environments above, restricted to protected `main`. Set these
   secrets separately in each environment:

   | Secret                      | Value                                        |
   | --------------------------- | -------------------------------------------- |
   | `ARTIFACTORY_BASE_URL`      | Approved HTTPS artifact root ending in `/`   |
   | `ARTIFACTORY_OIDC_URL`      | Approved HTTPS token-exchange endpoint       |
   | `ARTIFACTORY_OIDC_AUDIENCE` | Optional audience; omit for GitHub's default |

   Secrets also mask deployment endpoints in public logs. Keep these settings
   at environment scope; repository or organization secrets can otherwise act
   as fallbacks. Redirects are rejected.

3. Configure each npm package's trusted publisher with this GitHub owner/repo
   and its workflow filename and environment from the table. Grant the required
   publish/dist-tag permissions. Configure the Artifactory issuer to trust the
   intended workflow, environment, protected branch and audience with read-only
   artifact access. Check actual OIDC claims against the deployed issuer policy.

Dispatch accepts package details, never a download URL. The constructed paths are:

```text
scoped:   BASE/@scope/name/-/@scope/name-version.tgz
unscoped: BASE/name/-/name-version.tgz
```

The Artifactory exchange uses `POST` with Bearer GitHub ID-token authorization
and returns `{ "username": "…", "token": "…" }` for Basic-authenticated downloads.
Publication preserves the original tarball. npm provenance requires its
`repository.url` to match the public GitHub publisher repository; npm verifies
source identity when accepting publication. Test representative packages before
adopting a central publisher. [npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/#prerequisites)

## Onboard a new package

Build the package first, then run from this repository with npm 11.15+ and an
npm account with 2FA and permission to publish the package:

```sh
bash scripts/onboard-package.sh /path/to/package
```

The Bash script (compatible with macOS Bash 3.2) first displays the package name,
scope, version, registry and **public** visibility. Type `y` or `yes` to continue;
Enter, EOF or any other answer cancels before login or publication. This flow
supports public packages only: `private: true` and restricted `publishConfig.access`
are rejected rather than overridden.

After confirmation, the script opens an interactive npm login and displays the
signed-in account and its 2FA status. Disabled or unverifiable 2FA stops publication
and triggers logout. A successful login alone does not satisfy npm's publishing
requirements; enable 2FA in npm Account settings and complete any publish-time
browser approval. The script then publishes the package publicly to npmjs and uses
[`npm trust`](https://docs.npmjs.com/cli/v12/commands/npm-trust/)
to authorize `atlassian-labs/artifactory-npm-publisher` with
`publish-npm.yml` and its `npmjs-prod` environment.
The script accepts only the package directory. Lifecycle scripts are disabled,
so include all built files before running. The path must be the package to publish,
not this private publisher repository.

Credentials and cache use a temporary directory. Cleanup calls
[`npm logout`](https://docs.npmjs.com/cli/v12/commands/npm-logout/) to revoke that
login and removes the directory on success, failure, Ctrl-C or SIGTERM. Existing
npm credentials are untouched. A failed logout reports that server-side revocation
is unconfirmed; a forced kill or power loss cannot run cleanup.

If publishing succeeds but trust setup fails, the version stays published.
Configure its trusted publisher in npm package settings instead of rerunning the
publish. To finish onboarding, enable **Allow npm dist-tag** in the package's
trusted publisher settings for `publish-npm.yml` / `npmjs-prod`, keeping
**Allow npm publish** enabled. npm 12.2.1 cannot grant dist-tag permission through
`npm trust`, so the script prints this required manual step. Existing connections
cannot be edited: recreate the connection with the same repository, workflow and
environment, selecting both permissions ([npm permissions](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)).
Publish the next version through the OIDC workflow within **2 days** to validate
the new trust configuration before it expires ([npm expiry rules](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)).
The initial manual publish does not validate this trust. The pilot must also
verify the provenance requirements described above.

## Dispatch and completion

| Input          | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `operation`    | `publish`, `dist-tag-add` or `dist-tag-remove`     |
| `package_name` | Bare lowercase name, e.g. `widget`                 |
| `scope`        | Scope without `@`; blank for unscoped packages     |
| `version`      | Exact version for publish/add; ignored for removal |
| `dist_tag`     | Tag; defaults to the stage's value above           |
| `operation_id` | Stable opaque public correlation ID                |

Dispatch the appropriate workflow with `ref: main` through the Actions UI or
[workflow-dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
In public repositories, package details, operation IDs, summaries, receipts and logs are public.
Raw responses, package contents and npm debug output are suppressed;
temporary files and credentials are removed on exit.

A `completed` receipt means the npm CLI exited successfully. Dispatch acceptance
alone is not completion. The caller tracks run conclusions, deduplicates operation
IDs, preserves ordering and reconciles registry state after failures or ambiguous
retries. Writes are never automatically retried. Tag removal deletes the current
tag without an expected-version guard. Both workflows share per-package
concurrency; pace dispatch and handle queue overflow or cancellation.

## Development

Use Node.js 24.15+ on the 24 LTS line, or Node.js 26+:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit --audit-level=high
```

Actions are SHA-pinned; dependencies and npm CLI 12.2.1 are locked. npm 12.2.1
includes security fixes (`next-12` channel). Dependabot proposes weekly updates;
Node setup selects Node 24 patches.
Local tests mock services and run an offline npm dry-run. Complete a hosted pilot
to verify both environments' trust, artifact layout and live publishing behavior.
