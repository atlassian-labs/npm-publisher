import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { DEPLOYMENTS } from '../.github/scripts/publisher.js';
import {
  checkPublicText,
  validateWorkflow,
} from '../.github/scripts/check-workflows.js';

const publisher = (stage = 'prod') =>
  parse(
    readFileSync(`.github/workflows/${DEPLOYMENTS[stage].workflow}`, 'utf8'),
  );
const checks = () => parse(readFileSync('.github/workflows/check.yml', 'utf8'));
test('both publisher workflows validate and share package-wide concurrency', () => {
  for (const [stage, { workflow }] of Object.entries(DEPLOYMENTS))
    validateWorkflow(publisher(stage), workflow);
  assert.equal(
    publisher('prod').concurrency.group,
    publisher('staging').concurrency.group,
  );
});
for (const [stage, { workflow: file }] of Object.entries(DEPLOYMENTS)) {
  test(`${stage} workflow rejects credentials, caller-controlled endpoints and shell interpolation`, () => {
    for (const change of [
      (workflow) => {
        workflow.jobs.publish.steps.at(-1).env.NPM_TOKEN =
          '${{ secrets.NPM_TOKEN }}';
      },
      (workflow) => {
        workflow.jobs.publish.steps.at(-1).env.ARTIFACTORY_BASE_URL =
          '${{ inputs.url }}';
      },
      (workflow) => {
        workflow.jobs.publish.steps.at(-1).run =
          'echo ${{ inputs.package_name }}';
      },
    ]) {
      const workflow = publisher(stage);
      change(workflow);
      assert.throws(() => validateWorkflow(workflow, file));
    }
  });
  test(`${stage} workflow rejects broader permissions and loss of branch protection`, () => {
    const workflow = publisher(stage);
    workflow.jobs.publish.permissions.contents = 'write';
    assert.throws(() => validateWorkflow(workflow, file));
    const branch = publisher(stage);
    branch.jobs.publish.if = 'true';
    assert.throws(() => validateWorkflow(branch, file));
    const check = checks();
    check.permissions = 'write-all';
    assert.throws(() => validateWorkflow(check, 'check.yml'));
  });
  test(`${stage} workflow rejects crossed environments, stage overrides and unexpected jobs/runners`, () => {
    const other = stage === 'prod' ? 'staging' : 'prod';
    for (const change of [
      (workflow) => {
        workflow.jobs.publish.environment = DEPLOYMENTS[other].environment;
      },
      (workflow) => {
        workflow.jobs.publish.steps.at(-1).env.PUBLISHER_STAGE = other;
      },
      (workflow) => {
        workflow.jobs.publish.steps.at(-1).env.PUBLISHER_STAGE =
          '${{ inputs.stage }}';
      },
      (workflow) => {
        delete workflow.jobs.publish.steps.at(-1).env.PUBLISHER_STAGE;
      },
      (workflow) => {
        workflow.jobs.publish['runs-on'] = 'self-hosted';
      },
      (workflow) => {
        workflow.jobs.extra = structuredClone(workflow.jobs.publish);
      },
    ]) {
      const workflow = publisher(stage);
      change(workflow);
      assert.throws(() => validateWorkflow(workflow, file));
    }
  });
}
test('public endpoint checks allow fixtures and reject deployment literals without echoing them', () => {
  checkPublicText(
    'https://artifacts.example.test/npm/ https://docs.npmjs.com/',
    'fixture',
  );
  const privateUrl = 'https://' + ['private', 'invalid'].join('.') + '/npm/';
  assert.throws(
    () => checkPublicText(privateUrl, 'fixture'),
    (error) => !error.message.includes(privateUrl),
  );
});
