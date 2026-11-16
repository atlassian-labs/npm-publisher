import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('.github/scripts/publisher.js');
const parseReceipt = stdout => JSON.parse(stdout.trim().split('\n').at(-1));

// Run the production helper, replacing only network and npm process effects.
async function removeTag({ version = '1.2.3', body = '{"beta":"1.2.3"}', status = 200,
  fetchError = false } = {}) {
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
import { appendFileSync } from 'node:fs';
const record = effect => appendFileSync(${JSON.stringify(effects)}, JSON.stringify(effect) + '\\n');
globalThis.fetch = async (url, options) => {
  record({ type: 'read', url, redirect: options.redirect, hasSignal: !!options.signal,
    headers: options.headers });
  if (${fetchError}) throw new Error('private transport details');
  return new Response(${JSON.stringify(body)}, { status: ${status} });
};
childProcess.execFile = (command, args, options, callback) => {
  record({ type: 'write', command, args });
  queueMicrotask(() => callback(null, '', ''));
  return {};
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', preload, script], {
      env: { ...process.env, PUBLISHER_STAGE: 'prod', OPERATION: 'dist-tag-remove',
        PACKAGE_NAME: '@example/widget', PACKAGE_VERSION: version, DIST_TAG: 'beta',
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
  const result = await removeTag();
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
    const result = await removeTag(fixture);
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
    const result = await removeTag(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.effects.map(effect => effect.type), ['read']);
    assert(!`${result.stdout}${result.stderr}`.includes('private registry response'));
    assert(!`${result.stdout}${result.stderr}`.includes('private transport details'));
    assert.equal(result.summary, '');
    assert.deepEqual(result.remaining, []);
  }
});

test('unversioned manual removal keeps direct removal without a registry precheck', async () => {
  const result = await removeTag({ version: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.effects.map(effect => effect.type), ['write']);
  assert.equal(parseReceipt(result.stdout).status, 'completed');
  assert(!Object.hasOwn(parseReceipt(result.stdout), 'version'));
  assert.deepEqual(result.remaining, []);
});
