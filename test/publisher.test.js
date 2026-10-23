import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  artifactoryCredential, buildDownloadUrl, download, execute, npmEnvironment,
  REGISTRY, DEPLOYMENTS, MAIN_REF, validateManifest, publicErrorMessage,
  readRequest, writeArguments,
} from '../.github/scripts/publisher.js';

const env = {
  PUBLISHER_STAGE: 'prod',
  OPERATION: 'publish',
  PACKAGE_NAME: 'widget',
  PACKAGE_SCOPE: 'example',
  PACKAGE_VERSION: '1.2.3',
  DIST_TAG: 'oidc-test',
  OPERATION_ID: 'event-123',
  ARTIFACTORY_BASE_URL: 'https://artifacts.example.test/repository/npm/',
  ARTIFACTORY_OIDC_URL: 'https://auth.example.test/token?provider=github',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://vstoken.actions.githubusercontent.com/token?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-request-token',
};
const manifest = {
  name: '@example/widget', version: '1.2.3',
  repository: 'https://github.com/example-org/artifactory-npm-publisher',
  scripts: { prepublishOnly: 'exit 88', publish: 'exit 89', postpublish: 'exit 90' },
};
const request = changes => readRequest({ ...env, ...changes });
function archive(entries = [{ path: 'package/package.json', body: JSON.stringify(manifest) }]) {
  const blocks = [];
  for (const { path, body = '', type = '0' } of entries) {
    const header = Buffer.alloc(512);
    const content = Buffer.from(body);
    header.write(path, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const artifact = archive();
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function service(tarball = artifact) {
  const state = { calls: [], writes: [], masked: [] };
  state.fetchImpl = async (url, options) => {
    const address = String(url);
    state.calls.push({ url: address, options });
    assert.equal(options.redirect, 'error');
    if (address === env.ACTIONS_ID_TOKEN_REQUEST_URL) return json({ value: 'header.claims.signature' });
    if (address === env.ARTIFACTORY_OIDC_URL) return json({ username: 'temporary-user', token: 'temporary-token' });
    if (address === String(buildDownloadUrl(request(), env))) return new Response(tarball);
    assert.fail(`Unexpected request: ${new URL(address).origin}`);
  };
  state.maskImpl = value => state.masked.push(value);
  state.write = async (r, path, childEnv, directory) => {
    state.writes.push({ request: r, path, env: childEnv, directory });
    if (path) assert.deepEqual(await readFile(path), tarball);
  };
  return state;
}

test('both stages accept scoped and unscoped packages without registration', () => {
  assert.equal(MAIN_REF, 'refs/heads/main');
  for (const stage of Object.keys(DEPLOYMENTS)) {
    for (const scope of ['', 'another-scope']) {
      const r = request({ PUBLISHER_STAGE: stage, PACKAGE_SCOPE: scope, PACKAGE_NAME: 'another-widget' });
      assert.equal(r.fullName, scope ? `@${scope}/another-widget` : 'another-widget');
      assert.equal(r.stage, stage);
    }
  }
  for (const tag of ['latest', 'next', 'canary-123']) assert.equal(request({ DIST_TAG: tag }).tag, tag);
});
for (const [label, changes] of Object.entries({
  'invalid stage': { PUBLISHER_STAGE: '__proto__' },
  'unsupported operation': { OPERATION: 'deprecate' },
  'scope traversal': { PACKAGE_SCOPE: 'example/../../evil' },
  'name option injection': { PACKAGE_NAME: '--registry=evil' },
  'name URL injection': { PACKAGE_NAME: 'https://evil.example.test/a' },
  'oversized name': { PACKAGE_NAME: 'x'.repeat(215) },
  'version range': { PACKAGE_VERSION: '^1.2.3' },
  'version traversal': { PACKAGE_VERSION: '1.2.3/../../evil' },
  'leading-zero version': { PACKAGE_VERSION: '01.2.3' },
  'noncanonical build version': { PACKAGE_VERSION: '1.2.3+build.4' },
  'invalid tag': { DIST_TAG: '^latest' },
  'missing operation ID': { OPERATION_ID: '' },
  'operation ID injection': { OPERATION_ID: 'event\n::error::injected' },
})) test(`rejects ${label}`, () => assert.throws(() => request(changes)));

test('tag removal needs no package version', () => {
  for (const version of [undefined, '', 'ignored']) {
    const r = request({ OPERATION: 'dist-tag-remove', PACKAGE_VERSION: version });
    assert.equal(r.version, undefined);
    assert.deepEqual(writeArguments(r).slice(0, 4), ['dist-tag', 'rm', r.fullName, r.tag]);
  }
});
test('artifact URL uses the configured repository and validated package details', () => {
  assert.equal(String(buildDownloadUrl(request(), env)),
    'https://artifacts.example.test/repository/npm/@example/widget/-/@example/widget-1.2.3.tgz');
  assert.equal(String(buildDownloadUrl(request({ PACKAGE_SCOPE: '' }), { ...env, ARTIFACTORY_BASE_URL: 'https://staging.example.test/npm' })),
    'https://staging.example.test/npm/widget/-/widget-1.2.3.tgz');
  assert.equal(buildDownloadUrl({ ...request(), url: 'https://other.example.test/a.tgz' }, env).origin,
    'https://artifacts.example.test');
  for (const base of ['', 'http://artifacts.example.test/npm/', 'https://user:pass@artifacts.example.test/npm/',
    'https://artifacts.example.test/npm/?x=1', 'https://artifacts.example.test/npm/#fragment']) {
    assert.throws(() => buildDownloadUrl(request(), { ...env, ARTIFACTORY_BASE_URL: base }));
  }
});
test('effective manifest must match the requested identity and publication settings', () => {
  validateManifest(manifest, request());
  validateManifest({ ...manifest, tag: 'oidc-test', publishConfig: {
    registry: REGISTRY, tag: 'oidc-test', access: 'public', provenance: true,
  } }, request());
  for (const changes of [
    { name: '@other/widget' }, { version: '9.0.0' }, { tag: 'latest' },
    { publishConfig: 'invalid' }, { publishConfig: [] },
    { publishConfig: { registry: 'https://other.example.test/' } },
    { publishConfig: { tag: 'latest' } }, { publishConfig: { access: 'restricted' } },
    { publishConfig: { provenance: false } }, { publishConfig: { provenanceFile: '/tmp/file' } },
    { publishConfig: { ignoreScripts: false } },
  ]) assert.throws(() => validateManifest({ ...manifest, ...changes }, request()));
});
test('exchanges GitHub OIDC using POST and masks every download credential form', async () => {
  const state = service();
  const auth = await artifactoryCredential(env, state.fetchImpl, state.maskImpl);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].options.headers.Authorization, 'Bearer job-request-token');
  assert.equal(state.calls[1].url, env.ARTIFACTORY_OIDC_URL);
  assert.equal(state.calls[1].options.headers.Authorization, 'Bearer header.claims.signature');
  assert.equal(state.calls[1].options.method, 'POST');
  assert.equal(state.calls[1].options.body, 'null');
  const encoded = Buffer.from('temporary-user:temporary-token').toString('base64');
  assert.equal(auth, `Basic ${encoded}`);
  for (const value of ['header.claims.signature', 'temporary-user', 'temporary-token', encoded, auth]) {
    assert(state.masked.includes(value));
  }
});
test('optional audience is sent only to the GitHub OIDC request', async () => {
  const calls = [];
  await artifactoryCredential({ ...env, ARTIFACTORY_OIDC_AUDIENCE: 'https://audience.example.test' }, async url => {
    calls.push(new URL(url));
    return calls.length === 1 ? json({ value: 'id-token' }) : json({ username: 'user', token: 'token' });
  }, () => {});
  assert.equal(calls[0].searchParams.get('audience'), 'https://audience.example.test');
  assert.equal(calls[1].href, env.ARTIFACTORY_OIDC_URL);
});
test('invalid token responses and insecure exchange endpoints stop publication', async () => {
  for (const responses of [[{}], [{ value: '' }], [{ value: 'id-token' }, {}], [{ value: 'id-token' }, { username: 'user', token: '' }]]) {
    await assert.rejects(artifactoryCredential(env, async () => json(responses.shift()), () => {}));
  }
  await assert.rejects(artifactoryCredential({ ...env, ARTIFACTORY_OIDC_URL: 'http://auth.example.test/token' },
    async () => json({ value: 'id-token' }), () => {}), /HTTPS/);
});
test('HTTP errors and redirects suppress response bodies and stop after one request', async () => {
  for (const status of [302, 403, 404, 500]) {
    let calls = 0;
    await assert.rejects(download(request(), env, 'Basic temporary', async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Basic temporary');
      return new Response('private response body', { status });
    }), error => error.message.includes(`(${status})`) && !error.message.includes('private response body'));
    assert.equal(calls, 1);
  }
});
test('bounds advertised artifact sizes and streamed token response sizes', async () => {
  await assert.rejects(download(request(), env, 'Basic temporary', async () => new Response('x', {
    headers: { 'content-length': String(101 * 1024 * 1024) },
  })), /size limit/);
  await assert.rejects(artifactoryCredential(env, async () => ({
    ok: true, headers: new Headers(),
    body: (async function* () { for (let i = 0; i < 3; i++) yield Buffer.alloc(1024 * 1024); })(),
  }), () => {}), /size limit/);
});
test('publication downloads and parses once, writes once, and cleans temporary files', async () => {
  const state = service();
  assert.deepEqual(await execute(request(), env, state), { status: 'completed' });
  assert.equal(state.calls.length, 3, 'No registry preflight or polling is needed.');
  assert.equal(state.writes.length, 1);
  assert.equal(state.calls[2].options.headers.Authorization, state.masked.at(-1));
  await assert.rejects(readFile(state.writes[0].path), { code: 'ENOENT' });
});
test('validates the effective npm manifest after archive aliases and duplicates', async () => {
  for (const path of ['package//package.json', 'package/package.json']) {
    for (const changes of [{ name: '@unexpected/other' }, { tag: 'latest' }]) {
      const state = service(archive([
        { path: 'package/package.json', body: JSON.stringify(manifest) },
        { path, body: JSON.stringify({ ...manifest, ...changes }) },
      ]));
      await assert.rejects(execute(request(), env, state), /mismatch|conflicts/);
      assert.equal(state.writes.length, 0);
    }
  }
});
test('malformed artifacts fail before writes and leave no temporary directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'publisher-invalid-'));
  try {
    for (const data of [Buffer.from('not an archive'), archive([{ path: 'package/package.json', body: '{' }])]) {
      const state = service(data);
      await assert.rejects(execute(request(), { ...env, RUNNER_TEMP: parent }, state));
      assert.equal(state.writes.length, 0);
      assert.deepEqual(await readdir(parent), []);
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test('tag operations perform one write without artifact authentication or downloads', async () => {
  for (const operation of ['dist-tag-add', 'dist-tag-remove']) {
    const state = service();
    state.fetchImpl = async () => assert.fail('Tag operations must not make HTTP requests.');
    const r = request({ OPERATION: operation });
    assert.deepEqual(await execute(r, {}, state), { status: 'completed' });
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].path, undefined);
    assert.equal(state.masked.length, 0);
  }
});
test('failed or uncertain writes are not retried and still clean temporary files', async () => {
  const state = service();
  let directory;
  state.write = async (_r, _path, _env, temp) => {
    state.writes.push(temp);
    directory = temp;
    throw new Error('uncertain write');
  };
  await assert.rejects(execute(request(), env, state), /uncertain write/);
  assert.equal(state.writes.length, 1);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});
test('npm gets explicit write arguments, OIDC context and isolated configuration', () => {
  const clean = npmEnvironment({
    ...env, PATH: '/usr/bin', GITHUB_TOKEN: 'bad', NPM_TOKEN: 'bad', NODE_AUTH_TOKEN: 'bad',
    ARTIFACTORY_TOKEN: 'bad', NODE_OPTIONS: '--require=evil', npm_config_registry: 'https://other.example.test',
    NPM_CONFIG_USERCONFIG: '/other',
  }, '/tmp/worker');
  assert.equal(clean.ACTIONS_ID_TOKEN_REQUEST_TOKEN, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  for (const key of ['GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ARTIFACTORY_TOKEN', 'NODE_OPTIONS', 'npm_config_registry', 'ARTIFACTORY_BASE_URL']) {
    assert(!Object.hasOwn(clean, key));
  }
  assert.equal(clean.HOME, '/tmp/worker');
  assert.equal(clean.NPM_CONFIG_USERCONFIG, '/tmp/worker/user.npmrc');
  assert.equal(clean.NPM_CONFIG_GLOBALCONFIG, '/tmp/worker/global.npmrc');
  assert.equal(clean.NPM_CONFIG_FETCH_RETRIES, '0');
  for (const operation of ['publish', 'dist-tag-add', 'dist-tag-remove']) {
    const args = writeArguments(request({ OPERATION: operation }), '/tmp/package.tgz');
    for (const arg of ['--ignore-scripts', '--workspaces=false', `--registry=${REGISTRY}`]) assert(args.includes(arg));
    assert.equal(args.includes('--provenance'), operation === 'publish');
  }
});
test('public errors retain actionable validation messages and hide unexpected details', () => {
  assert(!publicErrorMessage(new Error('private service failure')).includes('private service'));
  try { request({ PACKAGE_NAME: '../../bad' }); }
  catch (error) { assert.match(publicErrorMessage(error), /Invalid package name/); }
});
test('pinned npm accepts the tarball offline without executing failing lifecycle scripts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'npm-worker-dry-run-'));
  try {
    const path = join(directory, 'package.tgz');
    await writeFile(path, artifact);
    const child = npmEnvironment(process.env, directory);
    await writeFile(child.NPM_CONFIG_USERCONFIG, `registry=${REGISTRY}\nignore-scripts=true\n`);
    await writeFile(child.NPM_CONFIG_GLOBALCONFIG, '');
    execFileSync(process.execPath, [resolve('node_modules/npm/bin/npm-cli.js'),
      ...writeArguments(request(), path).filter(arg => arg !== '--provenance'),
      '--dry-run', '--offline', '--provenance=false',
    ], { cwd: directory, env: child, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
