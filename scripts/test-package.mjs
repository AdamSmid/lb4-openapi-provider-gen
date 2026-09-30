import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run test:package.');

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, {cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const npm = (args, cwd) => command(process.execPath, [npmCli, ...args], cwd);
const temporary = await mkdtemp(join(tmpdir(), 'lb4-provider-package-'));
try {
  const destination = join(temporary, 'tarballs');
  await mkdir(destination);
  // --json output is machine-readable; lifecycle messages go to stderr.
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', destination], root));
  const paths = pack.files.map(file => file.path);
  for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/cli.js', 'dist/generator.js', 'dist/generator.d.ts', 'src/generator.ts']) {
    assert.ok(paths.includes(required), `Package is missing ${required}`);
  }
  assert.ok(
    paths.every(path => /^(dist\/|src\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/.test(path)),
    `Unexpected package files: ${paths.join(', ')}`
  );
  const project = join(temporary, 'consumer');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({name: 'package-smoke-test', version: '1.0.0', private: true, type: 'module'}));
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(destination, pack.filename)], project);
  const installed = join(project, 'node_modules', manifest.name);
  const cli = join(installed, 'dist/cli.js');
  assert.equal(command(process.execPath, [cli, '--version'], project).trim(), manifest.version);
  assert.match(command(process.execPath, [cli, '--help'], project), /Usage: lb4-openapi-provider-gen/);
  // Test npm's actual installed bin, not only node dist/cli.js.
  assert.equal(npm(['exec', '--offline', '--', 'lb4-openapi-provider-gen', '--version'], project).trim(), manifest.version);
  if (process.platform !== 'win32') {
    const binary = join(project, 'node_modules/.bin/lb4-openapi-provider-gen');
    assert.ok((await stat(binary)).mode & 0o111, 'Installed CLI must be executable');
    assert.equal(command(binary, ['--version'], project).trim(), manifest.version);
  }
  const specification = join(root, 'examples/inventory.openapi.yaml');
  const output = join(project, 'inventory.service.ts');
  command(process.execPath, [cli, specification, '--name', 'Inventory', '--output', output], project);
  command(process.execPath, [cli, specification, '--name', 'Inventory', '--output', output, '--check'], project);
  assert.match(await readFile(output, 'utf8'), /class InventoryService implements Provider<Inventory>, Inventory/);
  const libraryTest = join(project, 'library-test.mjs');
  await writeFile(
    libraryTest,
    `import {generateProvider} from 'lb4-openapi-provider-gen';
const result = await generateProvider({openapi: '3.0.3', info: {title: 'Test', version: '1'}, paths: {'/ping': {get: {operationId: 'ping', responses: {204: {description: 'OK'}}}}}}, {name: 'Test'});
if (result.operationCount !== 1 || !result.code.includes('TestService')) throw new Error('Invalid library output');
`
  );
  command(process.execPath, [libraryTest], project);
  const declarationTest = join(project, 'library-test.mts');
  await writeFile(
    declarationTest,
    `import {generateProvider, type GeneratorOptions, type GeneratorResult} from 'lb4-openapi-provider-gen';
const options: GeneratorOptions = {name: 'Inventory'};
const result: Promise<GeneratorResult> = generateProvider({}, options);
void result;
`
  );
  const compiler = join(project, 'node_modules/typescript/lib/tsc.js');
  command(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', declarationTest], project);
  console.log(`Verified ${pack.filename}: ${paths.length} files, CLI binary, generation, ESM import and TypeScript declarations in an isolated production install.`);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
