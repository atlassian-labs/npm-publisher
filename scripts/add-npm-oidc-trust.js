#!/usr/bin/env node
// Create a GitHub Actions trusted publisher that allows npm publish, npm stage
// publish and npm dist-tag in one configuration.
//
// `npm trust github` cannot do this: its permission list holds only
// createPackage and createStagedPackage (node_modules/npm/lib/trust-cmd.js),
// which is why there is no --allow-dist-tag flag. The registry enum also
// accepts manageDistTags, so the configuration is posted directly.
//
// A package with no configuration gets one in a single POST. A package whose
// configuration lacks dist-tag is replaced, since the registry offers no
// update and POST conflicts with an existing entry; the original is put back
// if the replacement fails.
//
// Packages come from .github/scripts/oidc-packages.txt unless named as
// arguments. A full-list run records what it settles and resumes on re-run.
//
// --otp-command (or NPM_OTP_COMMAND) names a command that prints a one-time
// code, so a password manager can supply it instead of someone typing it:
//   --otp-command 'keeper totp <record-uid>'
//
//   node scripts/add-oidc-trust.js --dry-run
//   node scripts/add-oidc-trust.js --limit 3      # first 3 pending
//   node scripts/add-oidc-trust.js
//   node scripts/add-oidc-trust.js @scope/one @scope/two
//
// Auth comes from NPM_TOKEN or the registry token in .npmrc; the value is never
// printed. The token alone is not enough for these endpoints, so a one-time
// code is requested as soon as the registry asks and then reused until it is
// rejected or throttled.

import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

// Packages to configure, one per line. Command-line arguments override it.
const PACKAGES_FILE = new URL('../.github/scripts/oidc-packages.txt', import.meta.url);

// Packages already settled, so an interrupted run resumes instead of redoing
// work. Only outcomes that need no further action are recorded.
const PROGRESS_FILE = new URL('./add-oidc-trust-progress.json', import.meta.url);
const SETTLED = new Set(['created', 'upgraded', 'already-complete']);

// Shared trusted-publisher configuration for bulk migration and onboarding.
const TRUST = {
  type: 'github',
  claims: {
    repository: 'atlassian-labs/npm-publisher',
    workflow_ref: { file: 'publish-npm.yml' },
    environment: 'prod',
  },
};

// createPackage -> "npm publish", createStagedPackage -> "npm stage publish",
// manageDistTags -> "npm dist-tag".
const PERMISSIONS = ['createPackage', 'createStagedPackage', 'manageDistTags'];

const REGISTRY = 'https://registry.npmjs.org';
const PAUSE_MS = 2000;
// A code is retired after this many calls. npm documents no limit; one run saw
// a 429 {"message":"OTP verification failed"} at about the 33rd call on a single
// code, so this ceiling sits above that and the 429 backoff does the real work.
const MAX_CODE_USES = 100;
const VALID_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const args = process.argv.slice(2);
let dryRun = false;
let limit = Infinity;
let otpCommand = process.env.NPM_OTP_COMMAND ?? null;
const named = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--dry-run') dryRun = true;
  else if (argument === '--limit') limit = Number(args[++index]);
  else if (argument === '--otp-command') otpCommand = args[++index];
  else if (argument.startsWith('-')) throw new Error(`Unknown argument: ${argument}`);
  else named.push(argument);
}
if (!Number.isFinite(limit) && limit !== Infinity) throw new Error('--limit needs a number.');

let token;
let oneTimePassword = null;
// How often the registry made us prove two-factor, which is the figure that
// decides whether this scales past a handful of packages.
let proofCount = 0;
// Calls made with the current code, so it can be retired before the registry
// starts throttling its verification.
let codeUses = 0;

async function readToken() {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;
  for (const candidate of [new URL('../.npmrc', import.meta.url), join(homedir(), '.npmrc')]) {
    let contents;
    try {
      contents = await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const match = contents.match(/^\s*\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(.+)$/m);
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (value && !value.startsWith('${')) return value;
  }
  throw new Error('No npmjs.org token found. Run `npm login --registry=https://registry.npmjs.org/ --auth-type=web`.');
}

async function loadPackages() {
  const contents = await readFile(PACKAGES_FILE, 'utf8');
  const names = [...new Set(contents.split(/[\s,]+/).filter(Boolean))];
  if (!names.length) throw new Error(`No packages listed in ${PACKAGES_FILE.pathname}`);
  return names;
}

async function loadProgress() {
  try {
    const stored = JSON.parse(await readFile(PROGRESS_FILE, 'utf8'));
    return Array.isArray(stored.done) ? stored.done : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const saveProgress = done => writeFile(PROGRESS_FILE, `${JSON.stringify({ done }, null, 2)}\n`);

// With --otp-command, the code comes straight from whatever supplies it (a
// password manager's CLI, say) instead of being typed each time. Its output is
// read as the code and never printed.
async function runOtpCommand() {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', otpCommand], {
    timeout: 60_000,
    maxBuffer: 1024 * 64,
  });
  const code = stdout.trim().split(/\s+/).pop() ?? '';
  if (!/^[0-9]{6,8}$/.test(code))
    throw new Error('--otp-command did not return a 6-8 digit code (output not shown)');
  return code;
}

async function askForOneTimePassword(reason) {
  process.stderr.write(`${reason}\n`);

  if (otpCommand) {
    try {
      oneTimePassword = await runOtpCommand();
      proofCount += 1;
      codeUses = 0;
      process.stderr.write('  got a fresh code from --otp-command\n');
      return;
    } catch (error) {
      process.stderr.write(`  --otp-command failed: ${error.message}\n  falling back to prompt\n`);
    }
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await readline.question('npm one-time password: ')).trim();
    if (!answer) throw new Error('No one-time password entered; stopping.');
    oneTimePassword = answer;
    proofCount += 1;
    codeUses = 0;
  } finally {
    readline.close();
  }
}

async function registryRequest(method, path, body) {
  let authAttempts = 0;
  let throttleAttempts = 0;

  for (;;) {
    // The registry verifies the attached code on every call and starts
    // answering 429 after roughly thirty checks of the same one, so retire it
    // before that rather than discovering the limit mid-run.
    if (oneTimePassword && codeUses >= MAX_CODE_USES) {
      oneTimePassword = null;
      codeUses = 0;
    }

    const response = await fetch(`${REGISTRY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(oneTimePassword ? { 'npm-otp': oneTimePassword } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (oneTimePassword) codeUses += 1;

    const text = await response.text();
    if (response.ok) {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    }

    // 429 is throttling, and measurement shows the limit is not tied to the
    // code: it kept arriving across several genuinely different codes and more
    // than two minutes of waiting, so it is a rolling window on this account's
    // trust calls. The code is therefore kept — replacing it only adds a 401
    // round trip, which counts against the very limit being waited out. Waiting
    // is the only thing that clears it.
    if (response.status === 429) {
      throttleAttempts += 1;
      if (throttleAttempts > 6)
        throw new Error(`${method} ${path} -> 429 after ${throttleAttempts - 1} backoffs: ${text.slice(0, 200)}`);
      const header = Number(response.headers.get('retry-after')) * 1000;
      const wait = header > 0 ? header : Math.min(15_000 * 2 ** (throttleAttempts - 1), 300_000);
      process.stderr.write(`\n    throttled (429); waiting ${Math.round(wait / 1000)}s\n`);
      await sleep(wait);
      continue;
    }

    // Any 401/403 here is a two-factor demand, whether or not it names OTP.
    if (response.status === 401 || response.status === 403) {
      authAttempts += 1;
      if (authAttempts > 5)
        throw new Error(`${method} ${path} -> ${response.status} after ${authAttempts - 1} two-factor attempts`);
      await askForOneTimePassword(
        oneTimePassword
          ? `Rejected (${response.status}). That code may have expired.`
          : `The registry wants two-factor proof (${response.status}).`,
      );
      continue;
    }

    const error = new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
}

const trustPath = name => `/-/package/${encodeURIComponent(name)}/trust`;

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['objects', 'configurations', 'trustedPublishers', 'results'])
    if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

// Same provider, repository, workflow file and environment as TRUST.
const matchesOurs = configuration =>
  configuration.type === TRUST.type &&
  configuration.claims?.repository === TRUST.claims.repository &&
  configuration.claims?.workflow_ref?.file === TRUST.claims.workflow_ref.file &&
  (configuration.claims?.environment ?? null) === (TRUST.claims.environment ?? null);

// Confirm the configuration came back with everything that was asked for.
async function verifyGranted(name, wanted) {
  const after = asList(await registryRequest('GET', trustPath(name))).find(matchesOurs);
  const granted = after?.permissions ?? [];
  const missing = wanted.filter(permission => !granted.includes(permission));
  if (missing.length) throw new Error(`saved but missing [${missing.join(', ')}]`);
  return granted;
}

// The registry has no update for permissions and POST conflicts with an
// existing configuration, so adding dist-tag means replacing it. The original
// is recreated if the replacement fails, so a package is not left untrusted.
async function upgrade(name, existing, wanted) {
  const original = existing.permissions ?? [];
  const replacement = { type: existing.type, claims: existing.claims };

  await registryRequest('DELETE', `${trustPath(name)}/${encodeURIComponent(existing.id)}`);
  try {
    await registryRequest('POST', trustPath(name), [{ ...replacement, permissions: wanted }]);
  } catch (error) {
    try {
      await registryRequest('POST', trustPath(name), [
        { ...replacement, permissions: original },
      ]);
      error.message += ` (original [${original.join(', ')}] restored)`;
    } catch (restoreError) {
      error.message +=
        ` (RESTORE ALSO FAILED: ${restoreError.message} — ${name} may now have` +
        ` no trusted publisher; recreate it by hand)`;
    }
    throw error;
  }
}

async function addTrust(name) {
  const existing = asList(await registryRequest('GET', trustPath(name)));
  const ours = existing.find(matchesOurs);

  if (ours) {
    const permissions = ours.permissions ?? [];
    if (PERMISSIONS.every(permission => permissions.includes(permission)))
      return { status: 'already-complete', detail: `permissions=[${permissions.join(', ')}]` };

    const wanted = [...new Set([...permissions, ...PERMISSIONS])];
    if (dryRun)
      return {
        status: 'would-upgrade',
        detail: `delete+recreate ${ours.id} -> [${wanted.join(', ')}]`,
      };
    if (!ours.id) throw new Error(`existing configuration has no id: ${JSON.stringify(ours)}`);

    await upgrade(name, ours, wanted);
    return { status: 'upgraded', detail: `permissions=[${(await verifyGranted(name, wanted)).join(', ')}]` };
  }

  if (dryRun) return { status: 'would-create', detail: `permissions=[${PERMISSIONS.join(', ')}]` };

  await registryRequest('POST', trustPath(name), [{ ...TRUST, permissions: PERMISSIONS }]);
  return {
    status: 'created',
    detail: `permissions=[${(await verifyGranted(name, PERMISSIONS)).join(', ')}]`,
  };
}

async function main() {
  // Names given on the command line are always re-checked; a full-list run
  // skips whatever progress already recorded as settled.
  const explicit = named.length > 0;
  const all = explicit ? named : await loadPackages();
  const invalid = all.filter(name => !VALID_NAME.test(name));
  if (invalid.length) throw new Error(`Invalid package names: ${invalid.join(', ')}`);

  const done = explicit ? [] : await loadProgress();
  const settled = new Set(done);
  const queue = all.filter(name => !settled.has(name)).slice(0, limit);

  token = await readToken();

  console.log(
    `${TRUST.claims.repository} / ${TRUST.claims.workflow_ref.file} / ${TRUST.claims.environment}`,
  );
  console.log(`permissions: ${PERMISSIONS.join(', ')}`);
  console.log(
    `${all.length} ${explicit ? 'named' : `listed in ${PACKAGES_FILE.pathname}`}, ` +
      `${settled.size} already done, ${queue.length} to process` +
      `${dryRun ? ' (dry run)' : ''}\n`,
  );

  const failures = [];
  const tally = new Map();
  let proofsRequested = 0;
  for (const [index, name] of queue.entries()) {
    if (index) await sleep(PAUSE_MS);
    process.stdout.write(`[${index + 1}/${queue.length}] ${name} ... `);
    const before = proofCount;
    try {
      const { status, detail } = await addTrust(name);
      console.log(`${status}${detail ? ` (${detail})` : ''}`);
      tally.set(status, (tally.get(status) ?? 0) + 1);
      if (!dryRun && !explicit && SETTLED.has(status)) {
        done.push(name);
        await saveProgress(done);
      }
    } catch (error) {
      console.log('FAILED');
      console.error(`  ${error.message}`);
      failures.push(name);
      tally.set('failed', (tally.get('failed') ?? 0) + 1);
    }
    proofsRequested += proofCount - before;
  }

  const summary = [...tally].map(([status, count]) => `${status}: ${count}`).join(', ');
  console.log(`\n${summary || 'nothing processed'}`);
  console.log(`two-factor proofs needed: ${proofsRequested} for ${queue.length} package(s)`);
  if (!explicit) console.log(`recorded settled: ${done.length}/${all.length}`);
  if (failures.length) {
    console.error(`failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
