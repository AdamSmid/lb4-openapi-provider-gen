#!/usr/bin/env node
import {readFile, mkdir, writeFile, rename, unlink, lstat, stat} from 'node:fs/promises';
import {basename, dirname, extname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {parseDocument} from 'yaml';
import {generateProvider, pascalCase} from './generator.js';

const help = `Usage: lb4-openapi-provider-gen <spec.json|spec.yaml> [options]

Generate a typed LoopBack provider from a local OpenAPI 3.0 specification.
Without --output, writes TypeScript to stdout. Diagnostics go to stderr.

  -n, --name <name>              Service interface (default: PascalCase filename)
  -o, --output <file>            Destination .ts file
      --provider-class <name>    Provider class (default: <name>Service)
      --datasource-class <name>  Existing datasource (default: <name>DataSource)
      --datasource-import <path> Import relative to output (default: ../datasources)
      --binding <key>            Injection key (default: datasources.<name>)
      --response <raw|body>      raw: connector response; body: transformResponse=true
  -f, --force                    Replace an existing file
      --check                    Exit 1 if --output is missing or out of date
  -h, --help                     Show help
  -v, --version                  Show version

The datasource must use positional: true. References must be document-local.
Example:
  lb4-openapi-provider-gen inventory.json --name Inventory -o inventory.service.ts
`;

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      name: {type: 'string', short: 'n'},
      output: {type: 'string', short: 'o'},
      'provider-class': {type: 'string'},
      'datasource-class': {type: 'string'},
      'datasource-import': {type: 'string'},
      binding: {type: 'string'},
      response: {type: 'string', default: 'raw'},
      force: {type: 'boolean', short: 'f'},
      check: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
      version: {type: 'boolean', short: 'v'},
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {version: string};
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Provide exactly one local OpenAPI file. Use --help for usage.');
  if (values.check && !values.output) throw new Error('--check requires --output.');
  if (values.check && values.force) throw new Error('--check and --force cannot be combined.');
  if (values.force && !values.output) throw new Error('--force requires --output.');
  if (values.response !== 'raw' && values.response !== 'body') throw new Error('--response must be raw or body.');
  const input = resolve(positionals[0]);
  const output = values.output ? resolve(values.output) : undefined;
  if (output && !output.endsWith('.ts')) throw new Error('--output must be a .ts file.');
  if (output) {
    const inputInfo = await stat(input);
    const outputInfo = await stat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (input === output || (outputInfo && inputInfo.dev === outputInfo.dev && inputInfo.ino === outputInfo.ino)) {
      throw new Error('Output must not overwrite the input specification.');
    }
  }
  const text = await readFile(input, 'utf8');
  let spec: unknown;
  if (extname(input).toLowerCase() === '.json') {
    try {
      spec = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON in ${input}.`);
    }
  } else {
    const document = parseDocument(text, {uniqueKeys: true});
    if (document.errors.length) throw new Error(`Invalid YAML in ${input}: ${document.errors[0].message}`);
    spec = document.toJS({maxAliasCount: 100});
  }
  const result = await generateProvider(spec, {
    name: values.name ?? pascalCase(basename(input, extname(input))),
    providerClass: values['provider-class'],
    datasourceClass: values['datasource-class'],
    datasourceImport: values['datasource-import'],
    binding: values.binding,
    response: values.response,
  });
  for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`);
  if (!output) {
    process.stdout.write(result.code);
    return;
  }
  if (values.check) {
    const existing = await readFile(output, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing !== result.code) {
      process.stderr.write(`Out of date: ${output}\n`);
      process.exitCode = 1;
    } else process.stderr.write(`Up to date: ${output}\n`);
    return;
  }
  await mkdir(dirname(output), {recursive: true});
  if (values.force) {
    // Refuse symlink destinations instead of unexpectedly replacing their targets.
    const existing = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symlink output.');
    const temporary = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, result.code, {flag: 'wx'});
      await rename(temporary, output);
    } finally {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } else {
    try {
      await writeFile(output, result.code, {flag: 'wx'});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${output} already exists. Use --force to replace it, or --check to compare.`);
      throw error;
    }
  }
  process.stderr.write(`Generated ${output} (${result.operationCount} operations, ${result.schemaCount} schemas).\n`);
}

main().catch(error => {
  process.stderr.write(`lb4-openapi-provider-gen: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
