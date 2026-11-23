import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('.github/scripts/publisher.js');
const parseReceipt = stdout => JSON.parse(stdout.trim().split('\n').at(-1));

// Run the production helper, replacing only network and npm process effects.
async function runPublisher({ operation = 'dist-tag-remove', version = '1.2.3',
  body = '{"beta":"1.2.3"}', status = 200, fetchError = false, download = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-js-test-'));
  const temp = join(directory, 'temp');
  const effects = join(directory, 'effects.jsonl');
  const summary = join(directory, 'summary');
  const preload = join(directory, 'preload.mjs');
  try {
    await mkdir(temp);
    await writeFile(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
const fixture = ${JSON.stringify({ operation, body, status, fetchError, download })};
const record = effect => appendFileSync(${JSON.stringify(effects)}, JSON.stringify(effect) + '\\n');
globalThis.fetch = async (url, options) => {
  record({ type: 'read', url, redirect: new Request(url, options).redirect, hasSignal: !!options.signal,
    headers: options.headers });
  if (fixture.operation === 'publish' && url.endsWith('.tgz')) {
    const { fetchError, readError, body = 'test tarball', status = 200, statusText = '' } = fixture.download;
    if (fetchError) throw new TypeError(fetchError.message,
      fetchError.cause ? { cause: new Error(fetchError.cause) } : undefined);
    const stream = readError ? new ReadableStream({
      start(controller) { controller.error(new Error(readError)); },
    }) : body;
    return new Response(stream, { status, statusText });
  }
  if (fixture.fetchError) throw new Error('private transport details');
  return new Response(fixture.body, { status: fixture.status });
};
childProcess.execFile = (command, args, options, callback) => {
  record({ type: 'write', command, args,
    tarball: args[0] === 'publish' ? readFileSync(args[1], 'utf8') : undefined });
  queueMicrotask(() => callback(null, '', ''));
  return {};
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', preload, script], {
      env: { ...process.env, PUBLISHER_STAGE: 'prod', OPERATION: operation,
        PACKAGE_NAME: '@example/widget', PACKAGE_VERSION: version, DIST_TAG: 'beta',
        ARTIFACTORY_BASE_URL: 'https://artifactory.example.test', ARTIFACTORY_ACCESS_TOKEN: 'test-artifactory-token',
        OPERATION_ID: 'event-123', RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8', timeout: 20_000,
    });
    if (result.error) throw result.error;
    const records = await readFile(effects, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    return { ...result, effects: records.trim().split('\n').filter(Boolean).map(JSON.parse),
      remaining: await readdir(temp), summary: await readFile(summary, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
      }) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('versioned tag removal checks the current target immediately before writing', async () => {
  const result = await runPublisher();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.effects.map(effect => effect.type), ['read', 'write']);
  assert.deepEqual(result.effects[0], { type: 'read',
    url: 'https://registry.npmjs.org/-/package/%40example%2Fwidget/dist-tags',
    redirect: 'error', hasSignal: true });
  assert.equal(result.effects[1].command, 'npm');
  assert.deepEqual(result.effects[1].args.slice(0, 4), ['dist-tag', 'rm', '@example/widget', 'beta']);
  assert.equal(parseReceipt(result.stdout).status, 'completed');
  assert.equal(parseReceipt(result.stdout).version, '1.2.3');
  assert.deepEqual(result.remaining, []);
});

test('moved or absent tags skip removal and report a truthful successful receipt', async () => {
  for (const fixture of [{ body: '{"beta":"2.0.0"}' }, { body: '{}' }, { status: 404 }]) {
    const result = await runPublisher(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
    assert.equal(parseReceipt(result.stdout).status, 'skipped');
    assert.match(result.summary, /"status": "skipped"/);
    assert.deepEqual(result.remaining, []);
  }
});

test('failed or malformed tag lookups fail closed without exposing responses', async () => {
  for (const fixture of [
    { status: 403, body: 'private registry response' },
    { status: 500, body: 'private registry response' },
    { status: 302, body: 'private registry response' },
    { fetchError: true },
    ...['private registry response', 'null', '[]', '{"beta":42}', '{"beta":null}', '{"beta":""}']
      .map(body => ({ body })),
  ]) {
    const result = await runPublisher(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
    assert(!`${result.stdout}${result.stderr}`.includes('private registry response'));
    assert(!`${result.stdout}${result.stderr}`.includes('private transport details'));
    assert.equal(result.summary, '');
    assert.deepEqual(result.remaining, []);
  }
});

test('unversioned manual removal keeps direct removal without a registry precheck', async () => {
  const result = await runPublisher({ version: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.effects.map(effect => effect.type), ['write']);
  assert.equal(parseReceipt(result.stdout).status, 'completed');
  assert(!Object.hasOwn(parseReceipt(result.stdout), 'version'));
  assert.deepEqual(result.remaining, []);
});

test('package downloads follow redirects by default and publish the downloaded content', async () => {
  const result = await runPublisher({ operation: 'publish', body: '{"dist-tags":{"beta":"1.2.3"}}',
    download: { body: 'downloaded tarball' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.effects.map(effect => effect.type), ['read', 'read', 'write']);
  const [download, metadata, publish] = result.effects;
  assert.equal(download.url, 'https://artifactory.example.test/artifactory/api/npm/npm-public/%40example/widget/-/%40example/widget-1.2.3.tgz');
  assert.equal(download.redirect, 'follow');
  assert.equal(download.hasSignal, true);
  assert.equal(download.headers.Authorization, 'Bearer test-artifactory-token');
  assert.equal(metadata.redirect, 'error');
  assert.equal(publish.command, 'npm');
  assert.equal(publish.args[0], 'publish');
  assert.equal(publish.tarball, 'downloaded tarball');
  assert.match(result.stdout, /Successfully downloaded @example\/widget@1\.2\.3/);
  assert.equal(parseReceipt(result.stdout).status, 'completed');
  assert.deepEqual(result.remaining, []);
});

test('failed downloads report HTTP status and response body without publishing', async () => {
  for (const download of [
    { status: 403, statusText: 'Forbidden', body: 'Permission denied for this package' },
    { status: 404, statusText: 'Not Found', body: '{"error":"Package version not found"}' },
    { status: 500, statusText: 'Internal Server Error', body: 'Storage unavailable' },
  ]) {
    const result = await runPublisher({ operation: 'publish', download });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`HTTP ${download.status} ${download.statusText}`));
    assert.ok(result.stderr.includes(download.body));
    assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
    assert.equal(result.summary, '');
    assert.deepEqual(result.remaining, []);
  }
});

test('download request failures report the original message and underlying cause', async () => {
  for (const fetchError of [
    { message: 'fetch failed', cause: 'getaddrinfo ENOTFOUND artifactory.example.test' },
    { message: 'The operation was aborted due to timeout' },
  ]) {
    const result = await runPublisher({ operation: 'publish', download: { fetchError } });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Artifact download request failed: ${fetchError.message}`));
    if (fetchError.cause) assert.ok(result.stderr.includes(fetchError.cause));
    assert.ok(!result.stderr.includes('undefined'));
    assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
    assert.deepEqual(result.remaining, []);
  }
});

test('download stream failures preserve the error and stop publishing', async () => {
  const result = await runPublisher({ operation: 'publish', download: { readError: 'Download connection reset' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Download connection reset/);
  assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
  assert.equal(result.summary, '');
  assert.deepEqual(result.remaining, []);
});
