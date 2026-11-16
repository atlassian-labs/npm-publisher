import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const registry = 'https://registry.npmjs.org/';
const temporaryTag = 'npm-publisher-temp';

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
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(180_000),
  }).catch(() => { throw new Error('Artifact download request failed; response details suppressed.'); });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Artifact download failed (HTTP ${response.status}); response suppressed.`);
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
  } catch {
    throw new Error('Unable to read the artifact download; response details suppressed.');
  }
  if (size > limit) throw new Error('Artifact exceeds the 100 MiB size limit.');
  const tarball = join(directory, 'package.tgz');
  await writeFile(tarball, Buffer.concat(chunks), { mode: 0o600 });
  return tarball;
}

// Artifactory publish events do not include tags, so fetch them from Artifactory.
// Tags may move while the event is queued; select one currently pointing to this version.
// No matching tag tells the caller to publish with a temporary tag and remove it.
async function selectPublishTag({ name, version }) {
  const base = (process.env.ARTIFACTORY_BASE_URL || '').replace(/\/$/, '');
  // Read the local source repository, not tags merged by a virtual repository.
  const response = await fetch(`${base}/artifactory/api/npm/npm-public-local/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${process.env.ARTIFACTORY_ACCESS_TOKEN}`, 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error('Artifactory tag lookup failed; response details suppressed.'); });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Artifactory tag lookup failed (HTTP ${response.status}); response suppressed.`);
  }
  const metadata = await response.json().catch(() => { throw new Error('Invalid Artifactory tag response.'); });
  const tags = metadata?.['dist-tags'];
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) ||
      Object.values(tags).some(value => typeof value !== 'string' || !value))
    throw new Error('Invalid Artifactory tag response.');
  const attached = Object.keys(tags).filter(tag => tags[tag] === version);
  if (!attached.length) return undefined;
  return attached.find(tag => tag !== 'latest') || 'latest';
}

async function tagStillTargetsVersion({ name, version, tag }) {
  const response = await fetch(`${registry}-/package/${encodeURIComponent(name)}/dist-tags`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error('npm tag lookup failed; response details suppressed.'); });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return false;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`npm tag lookup failed (HTTP ${response.status}); response suppressed.`);
  }
  const tags = await response.json().catch(() => { throw new Error('Invalid npm tag lookup response.'); });
  if (!tags || typeof tags !== 'object' || Array.isArray(tags))
    throw new Error('Invalid npm tag lookup response.');
  const current = Object.hasOwn(tags, tag) ? tags[tag] : undefined;
  if (current !== undefined && (typeof current !== 'string' || !current))
    throw new Error('Invalid npm tag lookup response.');
  return current === version;
}

async function writeToNpm(request, tarball) {
  if (request.operation === 'publish') request.tag = await selectPublishTag(request);
  const { operation, name, version, tag } = request;
  // npm always publishes with a tag; remove the temporary tag after an untagged publish.
  const publishWithoutTag = operation === 'publish' && !tag;
  if (publishWithoutTag) console.log(`No Artifactory tag points to this version; publishing with temporary tag ${temporaryTag}, then removing it.`);
  const commands = {
    publish: ['publish', tarball, `--tag=${tag || temporaryTag}`, '--access=public', '--provenance'],
    'dist-tag-add': ['dist-tag', 'add', `${name}@${version}`, tag],
    'dist-tag-remove': ['dist-tag', 'rm', name, tag],
  };
  const options = [`--registry=${registry}`, '--ignore-scripts', '--workspaces=false', '--loglevel=error'];
  if (name.startsWith('@')) options.push(`--${name.split('/')[0]}:registry=${registry}`);
  if (operation === 'dist-tag-remove' && version && !await tagStillTargetsVersion({ name, version, tag }))
    return 'skipped';
  const runNpm = async args => {
    console.log('npm', ...args);
    await run('npm', args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
  };
  try {
    await runNpm([...commands[operation], ...options]);
    if (publishWithoutTag) {
      await runNpm(['dist-tag', 'rm', name, temporaryTag, ...options]);
    }
    return 'completed';
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function main() {
  const request = readRequest();
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
