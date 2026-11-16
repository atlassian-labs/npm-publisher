import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const registry = 'https://registry.npmjs.org/';
const tag = "oidc-validation";

async function fetchJson(path) {
  const response = await fetch(`${registry}${path}`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm lookup failed (HTTP ${response.status}) for ${path}`);
  return response.json();
}

async function runNpm(args) {
  const command = [...args, `--registry=${registry}`, '--loglevel=error'];
  console.log('npm', ...command);
  try {
    const { stdout } = await run('npm', command, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout.trim()) console.log(stdout.trim());
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}

async function main() {
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error('Run this script in GitHub Actions with id-token: write.');
  const input = process.env.PACKAGES?.trim() ||
    await readFile(new URL('./oidc-packages.txt', import.meta.url), 'utf8');
  const packages = [...new Set(input.split(/[\s,]+/).filter(Boolean))];
  if (!packages.length) throw new Error('Provide validation_packages or add package names to oidc-packages.txt.');
  console.log('Checking OIDC dist-tag write access. npm still requires a first publish to validate a pending trust.');
  for (const [index, name] of packages.entries()) {
    if (index) await setTimeout(2000);
    try {
      if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
        throw new Error(`Invalid package name: ${name}`);
      const path = `-/package/${encodeURIComponent(name)}/dist-tags`;
      const tags = await fetchJson(path);
      if (Object.hasOwn(tags, tag)) throw new Error(`Temporary tag ${tag} already exists; refusing to overwrite it.`);
      // Tagless packages can use any existing version without publishing a new one.
      const version = tags.latest || Object.values(tags)[0] ||
        Object.keys((await fetchJson(encodeURIComponent(name))).versions || {}).at(-1);
      if (!version) throw new Error(`No published version found for ${name}.`);
      await runNpm(['dist-tag', 'add', `${name}@${version}`, tag]);
      try {
        if ((await fetchJson(path))[tag] !== version) throw new Error(`Temporary tag was not set for ${name}.`);
      } finally {
        await runNpm(['dist-tag', 'rm', name, tag]);
      }
      if (Object.hasOwn(await fetchJson(path), tag)) throw new Error(`Temporary tag ${tag} was not removed.`);
      console.log(`PASS ${name}: added and removed ${tag}.`);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `- PASS ${name}: dist-tag write access verified.\n`);
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
