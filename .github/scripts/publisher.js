import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const registry = 'https://registry.npmjs.org/';
const temporaryTag = 'npm-publisher';

function readRequest() {
  const { PUBLISHER_STAGE: stage, OPERATION: operation } = process.env;
  const name = process.env.PACKAGE_NAME || '';
  const version = process.env.PACKAGE_VERSION || '';
  const tag = operation === 'publish' ? undefined : process.env.DIST_TAG || '';
  const operationId = process.env.OPERATION_ID || '';
  if (!['prod', 'staging'].includes(stage)) throw new Error('Choose prod or staging.');
  if (!['publish', 'dist-tag-add', 'dist-tag-remove'].includes(operation)) throw new Error('Unsupported operation.');
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214)
    throw new Error('Invalid package name.');
  if (operation !== 'dist-tag-remove' && !version) throw new Error('Package version is required.');
  if (operation !== 'publish' && !/^[a-z][a-z0-9._-]{0,127}$/.test(tag)) throw new Error('Invalid distribution tag.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) throw new Error('Invalid or missing operation_id.');
  return { stage, operation, name, version, tag, operationId };
}

async function downloadPackage({ name, version }, directory) {
  const base = process.env.ARTIFACTORY_BASE_URL || '';
  const token = process.env.ARTIFACTORY_ACCESS_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw new Error('Missing or invalid Artifactory access token.');
  for (const value of [token, `Bearer ${token}`])
    console.log(`::add-mask::${value.replaceAll('%', '%25')}`);

  const packagePath = name.replaceAll('@', '%40');
  const url = `${base.replace(/\/$/, '')}/artifactory/api/npm/npm-public/${packagePath}/-/${packagePath}-${encodeURIComponent(version)}.tgz`;
  console.log(`Downloading ${name}@${version} from Artifactory...`);
  console.log(`Artifactory download URL: ${url}`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180_000),
  }).catch(error => {
    const details = [error.message, error.cause?.message].filter(Boolean).join(': ');
    throw new Error(`Artifact download request failed: ${details}`, { cause: error });
  });
  if (!response.ok) {
    const details = await response.text().catch(error => `Unable to read error response: ${error.message}`);
    throw new Error(`Artifact download failed (HTTP ${response.status} ${response.statusText}): ${details}`);
  }
  const limit = 100 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Artifact exceeds the 100 MiB size limit.');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) break;
      chunks.push(chunk);
    }
  } catch (error) {
    throw error;
  }
  if (size > limit) throw new Error('Artifact exceeds the 100 MiB size limit.');
  const tarball = join(directory, 'package.tgz');
  await writeFile(tarball, Buffer.concat(chunks), { mode: 0o600 });
  console.log(`Successfully downloaded ${name}@${version} from Artifactory (${size} bytes).`);
  return tarball;
}

async function fetchJson(url, label, { headers, allowNotFound = false } = {}) {
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error(`${label} failed; response details suppressed.`); });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    if (allowNotFound && response.status === 404) return undefined;
    throw new Error(`${label} failed (HTTP ${response.status}); response suppressed.`);
  }
  return response.json().catch(() => { throw new Error(`Invalid ${label} response.`); });
}

// Artifactory publish events do not include tags, so fetch them from Artifactory.
// Tags may move while the event is queued; select one currently pointing to this version.
// No matching tag tells the caller to publish with a temporary tag and remove it.
async function selectPublishTag({ name, version }) {
  const base = (process.env.ARTIFACTORY_BASE_URL || '').replace(/\/$/, '');
  console.log(`Looking up Artifactory tags for ${name}@${version}...`);
  // Read metadata from the same repository endpoint used for tarball downloads.
  const metadata = await fetchJson(`${base}/artifactory/api/npm/npm-public/${encodeURIComponent(name)}`, 'Artifactory tag lookup', {
    headers: { Authorization: `Bearer ${process.env.ARTIFACTORY_ACCESS_TOKEN}`, 'Cache-Control': 'no-cache' },
  });
  const tags = metadata?.['dist-tags'];
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) ||
      Object.values(tags).some(value => typeof value !== 'string' || !value))
    throw new Error('Invalid Artifactory tag response.');
  const attached = Object.keys(tags).filter(tag => tags[tag] === version);
  if (!attached.length) return undefined;
  const selectedTag = attached.find(tag => tag !== 'latest') || 'latest';
  console.log(`Selected Artifactory tag ${selectedTag} for ${name}@${version}.`);
  return selectedTag;
}

async function tagStillTargetsVersion({ name, version, tag }) {
  console.log(`Checking whether npm tag ${tag} points to ${name}@${version}...`);
  const tags = await fetchJson(`${registry}-/package/${encodeURIComponent(name)}/dist-tags`, 'npm tag lookup', {
    allowNotFound: true,
  });
  if (tags === undefined) return false;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags))
    throw new Error('Invalid npm tag lookup response.');
  const current = Object.hasOwn(tags, tag) ? tags[tag] : undefined;
  if (current !== undefined && (typeof current !== 'string' || !current))
    throw new Error('Invalid npm tag lookup response.');
  return current === version;
}

async function runNpm(args) {
  console.log('npm', ...args);
  const { stdout, stderr } = await run('npm', args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

// Cleanup is best effort: a published version must not be retried if tag removal fails.
async function removeTemporaryTag(name, options) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runNpm(['dist-tag', 'rm', name, temporaryTag, ...options]);
      console.log(`Successfully removed temporary tag ${temporaryTag} from ${name}.`);
      return;
    } catch (error) {
      console.error(`Temporary tag removal failed (attempt ${attempt}/3): ${error.stderr?.trim() || error.message}`);
      if (attempt < 3) await delay(2000);
    }
  }
  console.warn(`Temporary tag removal failed after 3 attempts; leaving tag ${temporaryTag} on ${name}.`);
}

async function writeToNpm(request, tarball) {
  if (request.operation === 'publish') request.tag = await selectPublishTag(request);
  const { operation, name, version, tag } = request;
  // npm always publishes with a tag; remove the temporary tag after an untagged publish.
  const publishWithoutTag = operation === 'publish' && !tag;
  if (publishWithoutTag) console.log(`No Artifactory tag points to this version; publishing with temporary tag ${temporaryTag}, then removing it.`);
  const commands = {
    publish: ['publish', tarball, `--tag=${tag || temporaryTag}`, '--access=public', '--provenance=false'],
    'dist-tag-add': ['dist-tag', 'add', `${name}@${version}`, tag],
    'dist-tag-remove': ['dist-tag', 'rm', name, tag],
  };
  const options = [`--registry=${registry}`, '--ignore-scripts', '--workspaces=false', '--loglevel=error'];
  if (name.startsWith('@')) options.push(`--${name.split('/')[0]}:registry=${registry}`);
  if (operation === 'dist-tag-remove' && version && !await tagStillTargetsVersion({ name, version, tag })) {
    console.log(`Skipping removal of npm tag ${tag} from ${name}: it does not point to ${version}.`);
    return 'skipped';
  }
  try {
    await runNpm([...commands[operation], ...options]);
    if (operation === 'publish') console.log(`Package ${name}@${version} published successfully.`);
    if (operation === 'dist-tag-add') console.log(`Successfully set npm tag ${tag} to ${name}@${version}.`);
    if (operation === 'dist-tag-remove') console.log(`Successfully removed npm tag ${tag} from ${name}.`);
    if (publishWithoutTag) await removeTemporaryTag(name, options);
    return 'completed';
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function main() {
  const request = readRequest();
  console.log(`Starting ${request.operation} for ${request.name} (stage: ${request.stage}, operation ID: ${request.operationId}).`);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'npm-worker-'));
  try {
    let tarball;
    if (request.operation === 'publish') {
      tarball = await downloadPackage(request, directory);
    }
    const status = await writeToNpm(request, tarball);
    const receipt = {
      stage: request.stage, operation_id: request.operationId, operation: request.operation,
      package: request.name, version: request.version || undefined, dist_tag: request.tag ?? null, status,
    };
    console.log(JSON.stringify(receipt));
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `### npm operation\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
