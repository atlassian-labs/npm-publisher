import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/onboard-package.sh');
const fakeNpm = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[0];
const option = (name) => args.find((arg) => arg.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
const config = option('userconfig');
fs.appendFileSync(process.env.CALLS, JSON.stringify({
  command, args, cwd: process.cwd(), config,
  inheritedAuth: Boolean(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || process.env.npm_config_userconfig),
}) + '\n');
if (command === '--version') console.log(process.env.TEST_NPM_VERSION || '12.2.1');
if (command === 'profile') {
  if (args[1] !== 'get' || args[2] !== 'name' || args[3] !== 'two-factor auth') process.exit(9);
  console.log('test-maintainer\t' + (process.env.TEST_TFA_MODE ?? 'auth-and-writes'));
}
if (command === 'login' && process.env.CHECK_INPUT && fs.readFileSync(0, 'utf8') !== 'interactive-answer\n') {
  process.exit(8);
}
if (command === 'login' && process.env.FAIL_AT !== 'login-empty') {
  fs.writeFileSync(config, '//registry.npmjs.org/:_authToken=fake-session\n');
}
if (command === 'logout' && process.env.FAIL_AT !== 'logout') fs.writeFileSync(config, '');
if (command === 'publish' && process.env.SIGNAL_AT_PUBLISH) {
  process.kill(process.ppid, process.env.SIGNAL_AT_PUBLISH);
  setInterval(() => {}, 1000);
} else if (process.env.FAIL_AT === command || (command === 'login' && process.env.FAIL_AT === 'login-empty')) {
  process.exitCode = 7;
}
`;

async function scenario(t, overrides = {}, { input = 'y\ninteractive-answer\n', manifest = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'onboard-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const packageDirectory = join(directory, 'package with spaces');
  const callsFile = join(directory, 'calls.jsonl');
  await mkdir(bin);
  await mkdir(packageDirectory);
  await writeFile(join(bin, 'npm'), fakeNpm, { mode: 0o700 });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({
    name: '@example/onboarding-test', version: '1.0.0', ...manifest,
  }));
  const existingConfig = '//registry.npmjs.org/:_authToken=existing-session\n';
  await writeFile(join(packageDirectory, '.npmrc'), existingConfig);
  const child = spawn('/bin/bash', [script, packageDirectory], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: callsFile,
      NPM_TOKEN: 'existing-session', NODE_AUTH_TOKEN: 'existing-session',
      npm_config_userconfig: join(packageDirectory, '.npmrc'), ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const log = await readFile(callsFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const calls = log.trim() ? log.trim().split('\n').map(JSON.parse) : [];
  for (const call of calls) {
    assert.equal(call.inheritedAuth, false);
    assert.notEqual(call.cwd, packageDirectory);
    assert.ok(call.args.includes('--registry=https://registry.npmjs.org/'));
    await assert.rejects(access(call.config));
  }
  assert.equal(await readFile(join(packageDirectory, '.npmrc'), 'utf8'), existingConfig);
  assert.ok(!output.includes('fake-session'));
  return { code, output, calls, packageDirectory: await realpath(packageDirectory) };
}

test('onboarding publishes then configures trust, revokes login, and preserves existing credentials', async (t) => {
  const { code, calls, output, packageDirectory } = await scenario(t);
  assert.equal(code, 0);
  assert.match(output, /Package: @example\/onboarding-test\nScope: @example\nVersion: 1.0.0\nVisibility: public/);
  assert.deepEqual(calls.map((call) => call.command), ['--version', 'login', 'profile', 'publish', 'trust', 'logout']);
  assert.match(output, /npm account: test-maintainer\nAccount 2FA: auth-and-writes/);
  const publish = calls.find((call) => call.command === 'publish');
  assert.ok(publish.args.includes(packageDirectory));
  assert.ok(publish.args.includes('--ignore-scripts'));
  assert.ok(publish.args.includes('--access=public'));
  assert.ok(!publish.args.some((arg) => arg.startsWith('--tag=')));
  assert.ok(publish.args.includes('--@example:registry=https://registry.npmjs.org/'));
  const trust = calls.find((call) => call.command === 'trust');
  for (const value of ['github', '@example/onboarding-test', '--repository=atlassian-labs/artifactory-npm-publisher',
    '--file=publish-npm.yml', '--environment=npmjs-prod', '--allow-publish']) {
    assert.ok(trust.args.includes(value));
  }
});

for (const [label, input] of [['Enter', '\n'], ['n', 'n\n'], ['no', 'no\n'], ['EOF', ''], ['invalid answer', 'maybe\n']]) {
  test(`${label} cancels before any npm command`, async (t) => {
    const { code, calls, output } = await scenario(t, {}, { input });
    assert.notEqual(code, 0);
    assert.deepEqual(calls, []);
    assert.match(output, /\[y\/N\]: /);
    assert.match(output, /Cancelled\. Nothing was published\./);
  });
}

test('unscoped package shows no scope and accepts explicit YES', async (t) => {
  const { code, calls, output } = await scenario(t, {}, {
    input: 'YES\n', manifest: { name: 'onboarding-test' },
  });
  assert.equal(code, 0);
  assert.match(output, /Scope: \(none\)/);
  assert.ok(calls.find((call) => call.command === 'publish').args.includes('--access=public'));
});

for (const manifest of [{ private: true }, { publishConfig: { access: 'restricted' } }]) {
  test(`refuses ${JSON.stringify(manifest)} before login or publication`, async (t) => {
    const { code, calls } = await scenario(t, {}, { manifest });
    assert.notEqual(code, 0);
    assert.deepEqual(calls, []);
  });
}

test('login receives stdin for interactive authentication', async (t) => {
  const { code } = await scenario(t, { CHECK_INPUT: '1' });
  assert.equal(code, 0);
});

for (const step of ['login', 'profile', 'publish', 'trust', 'logout']) {
  test(`${step} failure still removes local credentials and attempts revocation`, async (t) => {
    const { code, calls, output } = await scenario(t, { FAIL_AT: step });
    assert.notEqual(code, 0);
    assert.equal(calls.at(-1).command, 'logout');
    if (step === 'profile') assert.ok(!calls.some((call) => call.command === 'publish'));
    if (step === 'publish') assert.ok(!calls.some((call) => call.command === 'trust'));
    if (step === 'trust') assert.match(output, /version is published/);
    if (step === 'logout') assert.match(output, /revocation is unconfirmed/);
  });
}

for (const mode of ['disabled', '']) {
  test(`2FA status ${mode || 'unknown'} stops before publishing and revokes login`, async (t) => {
    const { code, calls, output } = await scenario(t, { TEST_TFA_MODE: mode });
    assert.notEqual(code, 0);
    assert.deepEqual(calls.map((call) => call.command), ['--version', 'login', 'profile', 'logout']);
    assert.match(output, mode === 'disabled' ? /Enable it in npm Account/ : /Could not verify account 2FA/);
  });
}

test('auth-only 2FA remains eligible for interactive publication', async (t) => {
  const { code, calls } = await scenario(t, { TEST_TFA_MODE: 'auth-only' });
  assert.equal(code, 0);
  assert.ok(calls.some((call) => call.command === 'publish'));
});

test('login failure without a token does not attempt logout', async (t) => {
  const { code, calls } = await scenario(t, { FAIL_AT: 'login-empty' });
  assert.notEqual(code, 0);
  assert.deepEqual(calls.map((call) => call.command), ['--version', 'login']);
});

test('old npm fails before login or publishing', async (t) => {
  const { code, calls } = await scenario(t, { TEST_NPM_VERSION: '11.6.2' });
  assert.notEqual(code, 0);
  assert.deepEqual(calls.map((call) => call.command), ['--version']);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops publishing and revokes the login`, async (t) => {
    const { code, calls } = await scenario(t, { SIGNAL_AT_PUBLISH: signal });
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.deepEqual(calls.map((call) => call.command), ['--version', 'login', 'profile', 'publish', 'logout']);
  });
}
