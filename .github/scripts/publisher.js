import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

const require = createRequire(import.meta.url);
const npmRoot = dirname(require.resolve('npm/package.json'));
const pacote = createRequire(join(npmRoot, 'package.json'))('pacote');

export const REGISTRY = 'https://registry.npmjs.org/';
export const MAIN_REF = 'refs/heads/main';
export const DEPLOYMENTS = {
  prod: { workflow: 'publish-npm.yml', environment: 'npmjs-prod' },
  staging: { workflow: 'publish-artifactory-npm-staging.yml', environment: 'npmjs-staging' },
};

class PublisherError extends Error {}
const fail = (message) => {
  throw new PublisherError(message);
};

export function readRequest(env) {
  const stage = env.PUBLISHER_STAGE;
  const operation = env.OPERATION;
  if (!Object.hasOwn(DEPLOYMENTS, stage)) fail('Choose prod or staging.');
  if (!['publish', 'dist-tag-add', 'dist-tag-remove'].includes(operation))
    fail('Unsupported operation.');
  const name = env.PACKAGE_NAME || '';
  const scope = env.PACKAGE_SCOPE || '';
  const fullName = scope ? `@${scope}/${name}` : name;
  const namePattern = /^[a-z0-9][a-z0-9._-]*$/;
  if (!namePattern.test(name) || (scope && !namePattern.test(scope)) || fullName.length > 214)
    fail('Invalid package name or scope.');
  const version = operation === 'dist-tag-remove' ? undefined : env.PACKAGE_VERSION || '';
  if (operation !== 'dist-tag-remove' && semver.valid(version) !== version)
    fail('An exact canonical package version is required.');
  const tag = env.DIST_TAG || '';
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(tag)) fail('Invalid distribution tag.');
  const operationId = env.OPERATION_ID || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId))
    fail('Invalid or missing operation_id.');
  return { stage, operation, fullName, version, tag, operationId };
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch {
    fail(`Set ${label} to an HTTPS URL without credentials or a fragment.`);
  }
}

export function buildDownloadUrl(request, env) {
  const base = httpsUrl(env.ARTIFACTORY_BASE_URL, 'ARTIFACTORY_BASE_URL');
  if (base.search) fail('ARTIFACTORY_BASE_URL must not contain a query.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(`${request.fullName}/-/${request.fullName}-${request.version}.tgz`, base);
}

async function responseBytes(url, options, fetchImpl, limit = 100 * 1024 * 1024) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(`HTTP request failed (${response.status}); response body suppressed.`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    fail('HTTP response exceeds size limit.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) fail('HTTP response exceeds size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function json(url, options, fetchImpl) {
  return JSON.parse(
    (await responseBytes(url, options, fetchImpl, 2 * 1024 * 1024)).toString('utf8'),
  );
}

export function mask(value) {
  console.log(
    `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`,
  );
}

export async function artifactoryCredential(env, fetchImpl = fetch, maskImpl = mask) {
  const oidcUrl = httpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL, 'ACTIONS_ID_TOKEN_REQUEST_URL');
  if (env.ARTIFACTORY_OIDC_AUDIENCE)
    oidcUrl.searchParams.set('audience', env.ARTIFACTORY_OIDC_AUDIENCE);
  const { value: idToken } = await json(
    oidcUrl,
    { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } },
    fetchImpl,
  );
  if (typeof idToken !== 'string' || !idToken) fail('GitHub did not return an OIDC token.');
  maskImpl(idToken);
  const { username, token } = await json(
    httpsUrl(env.ARTIFACTORY_OIDC_URL, 'ARTIFACTORY_OIDC_URL'),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: 'null',
    },
    fetchImpl,
  );
  if (typeof username !== 'string' || !username || typeof token !== 'string' || !token)
    fail('Artifactory did not return a username and token.');
  const encoded = Buffer.from(`${username}:${token}`).toString('base64');
  const authorization = `Basic ${encoded}`;
  for (const secret of [username, token, encoded, authorization]) maskImpl(secret);
  return authorization;
}

export function download(request, env, authorization, fetchImpl = fetch) {
  return responseBytes(
    buildDownloadUrl(request, env),
    { headers: { Authorization: authorization } },
    fetchImpl,
  );
}

export function validateManifest(manifest, request) {
  if (manifest.name !== request.fullName || manifest.version !== request.version)
    fail('Artifact package name/version mismatch.');
  // npm prefers a truthy top-level tag over the command-line default.
  if (manifest.tag && manifest.tag !== request.tag)
    fail('Artifact tag conflicts with the request.');
  const config = manifest.publishConfig ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) fail('Invalid publishConfig.');
  const allowed = {
    registry: [REGISTRY, REGISTRY.slice(0, -1)],
    tag: [request.tag],
    access: ['public'],
    provenance: [true],
  };
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value))
      fail('Artifact publishConfig conflicts with the requested publication.');
  }
}

export function writeArguments(request, tarballPath) {
  const { operation, fullName, version, tag } = request;
  const commands = {
    publish: ['publish', tarballPath, `--tag=${tag}`, '--access=public', '--provenance'],
    'dist-tag-add': ['dist-tag', 'add', `${fullName}@${version}`, tag],
    'dist-tag-remove': ['dist-tag', 'rm', fullName, tag],
  };
  return [
    ...commands[operation],
    `--registry=${REGISTRY}`,
    '--ignore-scripts',
    '--workspaces=false',
    '--loglevel=error',
  ];
}

export function npmEnvironment(env, directory) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key !== 'GITHUB_TOKEN' &&
        (/^(GITHUB_|RUNNER_|ACTIONS_ID_TOKEN_REQUEST_)/.test(key) ||
          ['PATH', 'TMPDIR', 'SYSTEMROOT', 'LANG', 'CI'].includes(key)),
    ),
  );
  return {
    ...clean,
    HOME: directory,
    NPM_CONFIG_USERCONFIG: join(directory, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(directory, 'global.npmrc'),
    NPM_CONFIG_CACHE: join(directory, 'cache'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_FETCH_RETRIES: '0',
  };
}

async function npmWrite(request, tarballPath, env, directory) {
  const childEnv = npmEnvironment(env, directory);
  await writeFile(childEnv.NPM_CONFIG_USERCONFIG, `registry=${REGISTRY}\nignore-scripts=true\n`, {
    mode: 0o600,
  });
  await writeFile(childEnv.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 });
  try {
    execFileSync(
      process.execPath,
      [join(npmRoot, 'bin/npm-cli.js'), ...writeArguments(request, tarballPath)],
      {
        cwd: directory,
        env: childEnv,
        timeout: 5 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const code = String(error.stderr || '').match(/npm error code ([A-Z0-9_]+)/)?.[1] || 'UNKNOWN';
    fail(`npm failed (${code}); reconcile the operation before retrying.`);
  }
}

export async function execute(
  request,
  env,
  { fetchImpl = fetch, write = npmWrite, maskImpl = mask } = {},
) {
  const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'npm-worker-'));
  try {
    let tarballPath;
    if (request.operation === 'publish') {
      const authorization = await artifactoryCredential(env, fetchImpl, maskImpl);
      const tarball = await download(request, env, authorization, fetchImpl);
      tarballPath = join(directory, 'package.tgz');
      await writeFile(tarballPath, tarball, { mode: 0o600 });
      // Read the effective manifest with the same parser used by the pinned CLI.
      const manifest = await pacote.manifest(tarballPath, {
        cache: join(directory, 'manifest-cache'),
        offline: true,
        ignoreScripts: true,
        fullReadJson: true,
        fullMetadata: true,
      });
      validateManifest(manifest, request);
    }
    await write(request, tarballPath, env, directory);
    return { status: 'completed' };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const request = readRequest(process.env);
  const result = await execute(request, process.env);
  const receipt = {
    stage: request.stage,
    operation_id: request.operationId,
    operation: request.operation,
    package: request.fullName,
    version: request.version,
    dist_tag: request.tag,
    ...result,
  };
  console.log(JSON.stringify(receipt));
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### npm operation\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`,
    );
}

export function publicErrorMessage(error) {
  return error instanceof PublisherError
    ? error.message
    : 'Publisher failed; inspect the operation before retrying.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(publicErrorMessage(error));
    process.exitCode = 1;
  });
}
