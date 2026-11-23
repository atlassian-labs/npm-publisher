#!/usr/bin/env node
// Onboard one or more packages: claim the name on npmjs.org if it is not there
// yet, give it a GitHub Actions trusted publisher allowing npm publish, npm
// stage publish and npm dist-tag.
//
// Interactive by design. It signs you in with `npm login --auth-type=web` when
// you are not already signed in, and opens npm's website for two-factor
// authentication, so no code is entered in the terminal. The token
// npm stores from that login is read from .npmrc and never printed.
//
// A name that does not exist on npm gets one placeholder version published,
// because a trusted publisher cannot be attached to a name that was never
// published. That publish defaults to --access public and proceeds automatically
// unless --dry-run is passed.
//
// Defaults: --access public, --version 0.0.0.
//
//   node scripts/onboard-package.js @scope/new-package
//   node scripts/onboard-package.js @scope/one @scope/two --dry-run
//   node scripts/onboard-package.js @scope/pkg --access restricted
//   node scripts/onboard-package.js @scope/pkg --version 0.0.1
//
// `npm trust github` cannot grant dist-tag: its permission list holds only
// createPackage and createStagedPackage (node_modules/npm/lib/trust-cmd.js), so
// the configuration is posted to the registry directly. A package that already
// has a configuration without dist-tag is replaced, since the registry offers
// no update and POST conflicts with an existing entry; the original is put back
// if the replacement fails, so a package is never left untrusted.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const REGISTRY = 'https://registry.npmjs.org';

// Matches the configuration used across this repository's packages.
const TRUST = {
  type: 'github',
  claims: {
    repository: 'atlassian-labs/npm-publisher',
    workflow_ref: { file: 'publish-npm.yml' },
    environment: 'prod',
  },
};

// createPackage -> "npm publish", createStagedPackage -> "npm stage publish",
// manageDistTags -> "npm dist-tag". createPackage also lets the workflow publish
// a name that does not exist yet, which is what onboarding needs.
const PERMISSIONS = ['createPackage', 'createStagedPackage', 'manageDistTags'];
const DIST_TAGS = 'manageDistTags';

const VALID_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PAUSE_MS = 2000;

let dryRun = false;
let access = 'public';
let firstVersion = '0.0.0';
const packages = [];

// Parsed from main so a bad flag reports as a message, not a stack trace.
function parseArguments() {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--access') access = argv[++index];
    else if (argument === '--version') firstVersion = argv[++index];
    else if (argument.startsWith('-')) throw new Error(`Unknown argument: ${argument}`);
    else packages.push(argument);
  }
  if (!['public', 'restricted'].includes(access))
    throw new Error(`--access must be public or restricted, got: ${access}`);
  if (!/^\d+\.\d+\.\d+$/.test(firstVersion))
    throw new Error(`--version must look like 1.2.3, got: ${firstVersion}`);
}

let token;

const run = (command, commandArgs, options = {}) =>
  new Promise(resolve => {
    const child = spawn(command, commandArgs, { ...options });
    let stdout = '';
    child.stdout?.on('data', chunk => (stdout += chunk));
    child.on('error', error => resolve({ ok: false, stdout, error: error.message }));
    child.on('close', code => resolve({ ok: code === 0, stdout, code }));
  });

// npm's own login handles the browser hand-off and any two-factor step, so it is
// given the terminal rather than being driven from here.
async function ensureLoggedIn() {
  const whoami = await run('npm', ['whoami', `--registry=${REGISTRY}/`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (whoami.ok && whoami.stdout.trim()) {
    console.log(`Signed in to npmjs.org as ${whoami.stdout.trim()}\n`);
    return;
  }

  console.log('Not signed in to npmjs.org. Starting npm login — finish it in your browser.\n');
  const login = await run('npm', ['login', `--registry=${REGISTRY}/`, '--auth-type=web'], {
    stdio: 'inherit',
  });
  if (!login.ok) throw new Error('npm login did not complete.');

  const after = await run('npm', ['whoami', `--registry=${REGISTRY}/`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!after.ok || !after.stdout.trim())
    throw new Error('Still not signed in after npm login; nothing was changed.');
  console.log(`\nSigned in as ${after.stdout.trim()}\n`);
}

// `npm config get` refuses to return auth tokens, so the npmrc files are read
// directly. The value is never logged.
async function readToken() {
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
  throw new Error('Signed in, but no npmjs.org token found in .npmrc.');
}

// Unauthenticated: 404 means the name has never been published.
async function packageExists(name) {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`could not check whether ${name} exists (HTTP ${response.status})`);
}

// A trusted publisher cannot be attached to a name that does not exist, so the
// name is claimed with one minimal version first. npm publish is given the
// terminal so its own two-factor prompt works, and the throwaway package
// directory lives outside the repository so nothing is left behind.
async function publishFirstVersion(name) {
  const directory = await mkdtemp(join(tmpdir(), 'onboard-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name,
          version: firstVersion,
          description: `Placeholder release claiming ${name}.`,
          publishConfig: { registry: `${REGISTRY}/`, access },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(directory, 'README.md'),
      `# ${name}\n\nPlaceholder release claiming this name so a trusted publisher can be attached.\n`,
    );

    const result = await run(
      'npm',
      ['publish', `--registry=${REGISTRY}/`, `--access=${access}`],
      { cwd: directory, stdio: 'inherit' },
    );
    if (!result.ok) throw new Error(`npm publish failed (exit ${result.code ?? '?'})`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Follow the same authUrl/doneUrl challenge used by npm's web authentication.
// The returned token goes in npm-otp; it is never shown to the user.
async function authenticateInBrowser({ authUrl, doneUrl }) {
  if (new URL(authUrl).origin !== 'https://www.npmjs.com' ||
      new URL(doneUrl).origin !== REGISTRY)
    throw new Error('Unexpected npm browser authentication URL.');

  console.log(`Authenticate your account in the browser:\n${authUrl}`);
  const opener = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', authUrl] : [authUrl];
  const opened = await run(opener, args, { stdio: 'ignore' });
  if (!opened.ok) console.log('Open the URL above manually to continue.');

  const signal = AbortSignal.timeout(5 * 60_000);
  for (;;) {
    const response = await fetch(doneUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    if (response.status === 200) {
      const result = await response.json();
      if (!result.token) throw new Error('npm browser authentication returned no verification token.');
      return result.token;
    }
    if (response.status !== 202)
      throw new Error(`npm browser authentication failed (HTTP ${response.status}).`);

    await response.body?.cancel();
    const wait = Math.max(1000, Number(response.headers.get('retry-after')) * 1000 || 1000);
    await sleep(wait, undefined, { signal });
  }
}

async function registryRequest(method, path, body) {
  // Browser verification belongs to this request, not later trust operations.
  let oneTimePassword = null;
  let authAttempts = 0;
  let throttleAttempts = 0;

  for (;;) {
    const response = await fetch(`${REGISTRY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'npm-auth-type': 'web',
        'npm-command': 'trust',
        ...(oneTimePassword ? { 'npm-otp': oneTimePassword } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (response.ok) {
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    }

    // 429 is a rolling window on this account's trust calls, not a bad code: it
    // keeps arriving across different codes, and replacing the code only adds a
    // 401 round trip that counts against the same limit. Waiting clears it.
    if (response.status === 429) {
      throttleAttempts += 1;
      if (throttleAttempts > 6)
        throw new Error(`${method} ${path} -> 429 after ${throttleAttempts - 1} backoffs`);
      const header = Number(response.headers.get('retry-after')) * 1000;
      const wait = header > 0 ? header : Math.min(15_000 * 2 ** (throttleAttempts - 1), 300_000);
      process.stderr.write(`\n  throttled (429); waiting ${Math.round(wait / 1000)}s\n`);
      await sleep(wait);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      authAttempts += 1;
      if (authAttempts > 5)
        throw new Error(`${method} ${path} -> ${response.status} after ${authAttempts - 1} attempts`);

      let challenge;
      try { challenge = JSON.parse(text); } catch { /* Handled below. */ }
      if (!challenge?.authUrl || !challenge?.doneUrl) {
        // An expired/rejected proof may suppress the next browser challenge.
        // Retry without it so npm can issue a fresh challenge for this request.
        if (oneTimePassword) {
          console.log('  Browser verification was rejected; requesting a fresh authentication challenge.');
          oneTimePassword = null;
          continue;
        }
        throw new Error(`${method} ${path} -> ${response.status}: npm did not provide a browser authentication challenge. Check your npm login and package permissions.`);
      }

      console.log('  npm requires browser authentication to continue.');
      oneTimePassword = await authenticateInBrowser(challenge);
      console.log('  Browser authentication completed.');
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

const matchesOurs = configuration =>
  configuration.type === TRUST.type &&
  configuration.claims?.repository === TRUST.claims.repository &&
  configuration.claims?.workflow_ref?.file === TRUST.claims.workflow_ref.file &&
  (configuration.claims?.environment ?? null) === (TRUST.claims.environment ?? null);

async function configureTrust(name) {
  console.log('  Checking whether OIDC trust already exists.');
  const existing = asList(await registryRequest('GET', trustPath(name))).find(matchesOurs);

  if (existing) {
    const permissions = existing.permissions ?? [];
    if (permissions.includes(DIST_TAGS))
      return 'OIDC trust already exists with dist-tag permission.';

    const wanted = [...new Set([...permissions, DIST_TAGS])];
    if (dryRun) return 'OIDC trust exists; would add dist-tag permission.';
    if (!existing.id) throw new Error(`existing configuration has no id for ${name}`);

    const replacement = { type: existing.type, claims: existing.claims };
    console.log('  OIDC trust exists; updating its permissions.');
    await registryRequest('DELETE', `${trustPath(name)}/${encodeURIComponent(existing.id)}`);
    try {
      await registryRequest('POST', trustPath(name), [{ ...replacement, permissions: wanted }]);
    } catch (error) {
      try {
        console.log(`  Upgrade failed; restoring the original trust for ${name}.`);
        await registryRequest('POST', trustPath(name), [
          { ...replacement, permissions },
        ]);
        error.message += ` (original [${permissions.join(', ')}] restored)`;
      } catch (restoreError) {
        error.message +=
          ` (RESTORE ALSO FAILED: ${restoreError.message} — ${name} may now have` +
          ` no trusted publisher; recreate it by hand)`;
      }
      throw error;
    }
    return 'OIDC trust has been updated successfully.';
  }

  if (dryRun) return 'OIDC trust does not exist; would create it.';
  console.log('  OIDC trust does not exist; creating it.');
  await registryRequest('POST', trustPath(name), [{ ...TRUST, permissions: PERMISSIONS }]);
  return 'OIDC trust has been created successfully.';
}

async function main() {
  parseArguments();
  if (!packages.length)
    throw new Error('Name at least one package, e.g. node scripts/onboard-package.js @scope/pkg');
  const invalid = packages.filter(name => !VALID_NAME.test(name));
  if (invalid.length) throw new Error(`Invalid package names: ${invalid.join(', ')}`);

  console.log(
    `${TRUST.claims.repository} / ${TRUST.claims.workflow_ref.file} / ${TRUST.claims.environment}`,
  );
  console.log(`permissions: ${PERMISSIONS.join(', ')}`);
  console.log(`${packages.length} package(s)${dryRun ? ' (dry run)' : ''}\n`);

  await ensureLoggedIn();
  token = await readToken();

  const failures = [];
  for (const [index, name] of packages.entries()) {
    if (index) await sleep(PAUSE_MS);
    console.log(`[${index + 1}/${packages.length}] ${name}`);
    try {
      if (await packageExists(name)) {
        console.log('  Package already exists on npm.');
      } else if (dryRun) {
        console.log(`  not on npm — would publish ${firstVersion} (${access})`);
      } else {
        console.log(`  not on npm. Publishing ${firstVersion} as ${access} claims the name.`);
        await publishFirstVersion(name);
        console.log(`  published ${firstVersion}`);
      }

      console.log(`  ${await configureTrust(name)}`);
    } catch (error) {
      console.log('  FAILED');
      console.error(`  ${error.message}`);
      failures.push(name);
    }
  }

  if (failures.length) {
    console.error(`\nfailed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
