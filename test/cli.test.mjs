import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
const yaml = `openapi: 3.0.3
info: {title: Test, version: 1.0.0}
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: {type: boolean}
`;

test('CLI supports YAML, stdout, protected writes, force, and read-only drift checks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-provider-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const input = join(dir, 'sample-api.yaml');
  const output = join(dir, 'nested/provider.ts');
  await writeFile(input, yaml);
  const stdout = run(input);
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.match(run('--help').stdout, /Usage: lb4-openapi-provider-gen/);
  assert.match(stdout.stdout, /interface SampleApi/);
  assert.match(stdout.stdout, /class SampleApiService implements Provider<SampleApi>/);
  assert.equal(run(input, '-o', output, '--check').status, 1);
  const generated = run(input, '-o', output);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stdout, '');
  assert.equal(await readFile(output, 'utf8'), stdout.stdout);
  assert.equal(run(input, '-o', output, '--check').status, 0);
  const overwrite = run(input, '-o', output);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /already exists/);
  await writeFile(output, '// edited by hand\n');
  assert.equal(run(input, '-o', output, '--check').status, 1);
  assert.equal(await readFile(output, 'utf8'), '// edited by hand\n');
  assert.equal(run(input, '-o', output, '--force').status, 0);
  assert.equal(await readFile(output, 'utf8'), stdout.stdout);
  const link = join(dir, 'link.ts');
  await symlink(output, link);
  assert.equal(run(input, '-o', link, '--force').status, 1);
  assert.equal(await readFile(output, 'utf8'), stdout.stdout);
});

test('CLI diagnoses bad flags and inputs and does not truncate existing output', async t => {
  assert.equal(run('--help').status, 0);
  assert.equal(run('--version').stdout.trim(), pkg.version);
  assert.equal(run('--no-such-option').status, 1);
  assert.equal(run().status, 1);
  const dir = await mkdtemp(join(tmpdir(), 'openapi-provider-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const input = join(dir, 'invalid.json');
  const output = join(dir, 'provider.ts');
  await writeFile(input, '{invalid JSON');
  await writeFile(output, '// keep me');
  assert.match(run(input, '-o', output, '--force').stderr, /Invalid JSON/);
  assert.equal(await readFile(output, 'utf8'), '// keep me');
  assert.match(run(input, '--check').stderr, /requires --output/);
  assert.match(run(input, '-o', output, '--check', '--force').stderr, /cannot be combined/);
  assert.match(run(input, '--response', 'wrong').stderr, /raw or body/);
  const source = join(dir, 'source.ts');
  await writeFile(source, yaml);
  assert.match(run(source, '-o', source, '--force').stderr, /input specification/);
  assert.equal(await readFile(source, 'utf8'), yaml);
});
