import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { MAIN_REF, DEPLOYMENTS } from './publisher.js';

const ENDPOINT_SECRETS = [
  'ARTIFACTORY_BASE_URL',
  'ARTIFACTORY_OIDC_URL',
  'ARTIFACTORY_OIDC_AUDIENCE',
];
const PUBLIC_HOSTS = new Set([
  'registry.npmjs.org',
  'github.com',
  'docs.github.com',
  'docs.npmjs.com',
  'opencollective.com',
]);

export function checkPublicText(text, file) {
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\]+/g)) {
    let url;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const host = url.hostname;
    const example =
      /(?:^|\.)(?:test|example)$/.test(host) ||
      /^(?:[^.]+\.)*example\.(?:com|org|net)$/.test(host);
    assert(
      PUBLIC_HOSTS.has(host) ||
        host.endsWith('.actions.githubusercontent.com') ||
        example,
      `${file}: keep deployment endpoints in protected environment settings.`,
    );
  }
}

export function validateWorkflow(workflow, file) {
  assert(workflow?.on && workflow.jobs, `${file}: missing triggers/jobs`);
  const deployment = Object.entries(DEPLOYMENTS).find(
    ([, settings]) => settings.workflow === file,
  );
  const publisher = Boolean(deployment);
  assert.deepEqual(
    workflow.permissions,
    publisher ? {} : { contents: 'read' },
    `${file}: unexpected default permissions`,
  );
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest', `${file}: unexpected runner`);
    assert(
      job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 15,
      `${file}: missing bounded timeout`,
    );
    assert(Array.isArray(job.steps), `${file}: expected ordinary job steps`);
    if (job.permissions)
      assert.deepEqual(
        job.permissions,
        publisher
          ? { contents: 'read', 'id-token': 'write' }
          : { contents: 'read' },
      );
    for (const step of job.steps) {
      if (step.uses)
        assert(
          /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/.test(step.uses),
          `${file}: action is not SHA-pinned`,
        );
      if (step.run)
        assert(
          !step.run.includes('${{'),
          `${file}: pass dynamic values through environment variables, not shell interpolation`,
        );
    }
  }
  const serialized = JSON.stringify(workflow);
  if (publisher) {
    const [stage, settings] = deployment;
    assert.deepEqual(Object.keys(workflow.jobs), ['publish']);
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(
      workflow['run-name'],
      'npm ' + stage + ' ${{ inputs.operation }}',
    );
    assert.equal(
      workflow.on.workflow_dispatch.inputs.dist_tag.default,
      stage === 'prod' ? 'latest' : 'oidc-test',
    );
    assert.equal(
      workflow.concurrency?.group,
      'npmjs:${{ inputs.scope }}:${{ inputs.package_name }}',
    );
    assert.equal(workflow.concurrency.queue, 'max');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    const job = workflow.jobs.publish;
    assert.equal(job.if, `github.ref == '${MAIN_REF}'`);
    assert.equal(job.environment, settings.environment);
    assert.deepEqual(job.permissions, {
      contents: 'read',
      'id-token': 'write',
    });
    assert(
      job.steps.some((step) => step.run?.includes('npm ci --ignore-scripts')),
    );
    let withoutSettings = serialized;
    for (const name of ENDPOINT_SECRETS)
      withoutSettings = withoutSettings.replaceAll(
        `secrets.${name}`,
        'masked-setting',
      );
    assert(
      !/\bsecrets\b/.test(withoutSettings),
      'Only confidential endpoint settings may reference secrets; use OIDC for credentials.',
    );
    const worker = job.steps.find(
      (step) => step.run === 'node .github/scripts/publisher.js',
    );
    assert(worker, 'Missing publisher invocation.');
    assert.equal(worker.env?.PUBLISHER_STAGE, stage);
    for (const name of ENDPOINT_SECRETS)
      assert.equal(worker.env?.[name], '${{ secrets.' + name + ' }}');
  } else {
    assert(
      !/\bid-token\b|\bsecrets\b/.test(serialized),
      `${file}: check jobs must not receive OIDC permissions or secrets`,
    );
  }
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await sourceFiles(path)));
    else if (
      /\.(?:js|json|md|ya?ml)$/.test(entry.name) &&
      !entry.name.endsWith('.local.json')
    )
      result.push(path);
  }
  return result;
}

async function main() {
  const workflowFiles = await readdir('.github/workflows');
  for (const { workflow } of Object.values(DEPLOYMENTS))
    assert(workflowFiles.includes(workflow), `Missing ${workflow}`);
  for (const file of workflowFiles) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = parse(
      await readFile(`.github/workflows/${file}`, 'utf8'),
      { uniqueKeys: true },
    );
    validateWorkflow(workflow, file);
    console.log(`${file}: workflow checks passed`);
  }
  const paths = [
    'README.md',
    'package.json',
    'package-lock.json',
    ...(await sourceFiles('.github')),
    ...(await sourceFiles('test')),
  ];
  for (const file of paths) checkPublicText(await readFile(file, 'utf8'), file);
  console.log('Public endpoint checks passed');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
