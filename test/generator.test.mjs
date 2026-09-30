import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {once} from 'node:events';
import ts from 'typescript';
import {parse} from 'yaml';
import {generateProvider} from '../dist/generator.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const options = {name: 'Sample', datasourceClass: 'TestDataSource', datasourceImport: './datasource'};
const json = schema => ({'application/json': {schema}});
const ok = schema => ({200: {description: 'Success', content: json(schema)}});

function fixture() {
  return {
    openapi: '3.0.3',
    info: {title: 'Test', version: '1.0.0'},
    paths: {
      '/things/{id}': {
        parameters: [
          {name: 'id', in: 'path', required: true, schema: {type: 'integer'}},
          {name: 'filter', in: 'query', schema: {type: 'integer'}},
        ],
        get: {
          operationId: 'Things.find',
          'x-operation-name': 'findThing',
          parameters: [{$ref: '#/components/parameters/Filter'}],
          responses: ok({$ref: '#/components/schemas/Thing'}),
        },
      },
      '/things': {
        post: {
          operationId: 'Things.create',
          'x-operation-name': 'createThing',
          requestBody: {$ref: '#/components/requestBodies/Create'},
          responses: {201: {$ref: '#/components/responses/Created'}, 204: {description: 'No body'}},
        },
      },
      '/ping': {get: {operationId: 'Health.ping', responses: ok({type: 'boolean'})}},
    },
    components: {
      schemas: {
        Thing: {
          type: 'object',
          required: ['id', 'name'],
          additionalProperties: false,
          properties: {
            id: {type: 'integer'},
            name: {type: 'string'},
            parent: {$ref: '#/components/schemas/Thing'},
            state: {type: 'string', enum: ['new', 'old'], nullable: true},
            created: {type: 'string', format: 'date-time'},
            labels: {type: 'array', items: {type: 'string'}},
            $ref: {type: 'string'},
            example: {$ref: '#/components/schemas/some~1name'},
          },
        },
        Composed: {
          allOf: [
            {$ref: '#/components/schemas/Thing'},
            {
              type: 'object',
              required: ['value'],
              properties: {value: {oneOf: [{type: 'string'}, {type: 'number'}]}},
            },
          ],
        },
        Dictionary: {type: 'object', additionalProperties: {type: 'integer'}},
        'some/name': {type: 'string'},
        Sample: {type: 'string'},
        Promise: {type: 'string'},
      },
      parameters: {Filter: {name: 'filter', in: 'query', schema: {type: 'string'}}},
      requestBodies: {Create: {required: true, content: json({$ref: '#/components/schemas/Thing'})}},
      responses: {Created: {description: 'Created', content: json({$ref: '#/components/schemas/Thing'})}},
    },
  };
}

async function workspace(t) {
  await mkdir(resolve(project, '.tmp'), {recursive: true});
  const dir = await mkdtemp(resolve(project, '.tmp/test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(resolve(dir, 'package.json'), '{"type":"commonjs"}');
  return dir;
}

async function compile(t, code, assertions = '') {
  const dir = await workspace(t);
  await writeFile(resolve(dir, 'provider.ts'), code);
  await writeFile(
    resolve(dir, 'datasource.ts'),
    `import {juggler} from '@loopback/service-proxy';
export class TestDataSource extends juggler.DataSource {}`
  );
  await writeFile(resolve(dir, 'usage.ts'), assertions);
  const program = ts.createProgram(
    ['provider.ts', 'datasource.ts', 'usage.ts'].map(file => resolve(dir, file)),
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      skipLibCheck: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      noEmitOnError: true,
      types: ['node'],
    }
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => project,
      getNewLine: () => '\n',
    })
  );
  assert.equal(program.emit().emitSkipped, false);
  return dir;
}

test('generated types compile and enforce schema, parameter order and response bodies', async t => {
  const result = await generateProvider(fixture(), options);
  assert.equal(result.operationCount, 3);
  assert.equal(result.schemaCount, 6);
  assert.equal(result.code, (await generateProvider(fixture(), options)).code);
  assert.deepEqual(result.warnings, []);
  await compile(
    t,
    result.code,
    `import {Sample, SampleService, Thing, Composed, Dictionary, SomeName, Sample2} from './provider';
declare const service: Sample;
declare const provider: SampleService;
provider.findThing(undefined, 12).then(res => res.body.name.toUpperCase());
provider.createThing({id: 1, name: 'A'});
// @ts-expect-error provider methods enforce request types too
provider.createThing({name: 'missing id'});
// @ts-expect-error the provider does not allow arbitrary methods
provider.nonexistent();
service.findThing(undefined, 12).then(res => res.body.name.toUpperCase());
service.createThing({id: 1, name: 'A', state: null}).then(res => res.body?.name);
service.Health_ping().then(res => {const body: boolean = res.body;});
const dict: Dictionary = {key: 1};
const name: SomeName = 'A';
const renamed: Sample2 = 'collision';
const composed: Composed = {id: 1, name: 'A', value: 2};
// @ts-expect-error missing required id slot; optional query cannot shift the path argument
service.findThing(12);
// @ts-expect-error wrong body shape
service.createThing({name: 'missing id'});
// @ts-expect-error no untyped index signature
service.nonexistent();
// @ts-expect-error enum values are preserved
const thing: Thing = {id: 1, name: 'A', state: 'invalid'};
// @ts-expect-error dates are wire strings
const date: Thing = {id: 1, name: 'A', created: new Date()};
// @ts-expect-error maps retain value types
const badMap: Dictionary = {key: 'wrong'};
`
  );
});

test('generated provider calls the real connector against a local HTTP server', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({url: request.url, method: request.method, body});
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.method === 'POST' ? JSON.parse(body) : {id: 12, name: 'Local'}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const spec = fixture();
  spec.servers = [{url: `http://127.0.0.1:${server.address().port}`}];
  for (const response of ['raw', 'body']) {
    const {code} = await generateProvider(spec, {...options, response});
    const dir = await compile(
      t,
      code,
      `import {service} from '@loopback/core';
import {SampleService} from './provider';
export class Consumer {
  constructor(@service(SampleService) public api: SampleService) {}
}`
    );
    const {SampleService} = require(resolve(dir, 'provider.js'));
    const {TestDataSource} = require(resolve(dir, 'datasource.js'));
    const datasource = new TestDataSource({
      // Swagger-client mutates its input while resolving and normalizing it.
      name: 'Test',
      connector: require('loopback-connector-openapi'),
      spec: structuredClone(spec),
      positional: true,
      validate: true,
      ...(response === 'body' ? {transformResponse: true} : {}),
    });
    t.after(() => datasource.disconnect());
    const provider = new SampleService(datasource);
    const {Context, createServiceBinding} = require('@loopback/core');
    const {Consumer} = require(resolve(dir, 'usage.js'));
    const context = new Context();
    context.bind('datasources.Sample').to(datasource);
    context.add(createServiceBinding(SampleService));
    context.bind('consumer').toClass(Consumer);
    const consumer = await context.get('consumer');
    // Exercise the provider directly, its returned proxy, and the app's injection pattern.
    for (const service of [provider, await provider.value(), consumer.api]) {
      const fetched = await service.findThing('hello world', 12);
      assert.equal((response === 'raw' ? fetched.body : fetched).name, 'Local');
      const payload = {id: 22, name: 'Created', labels: ['A']};
      const created = await service.createThing(payload);
      assert.deepEqual(response === 'raw' ? created.body : created, payload);
      await service.findThing(undefined, 12);
      await service.Health_ping();
    }
  }
  assert.deepEqual(
    requests.map(r => [r.method, r.url]),
    Array.from({length: 6}, () => [
      ['GET', '/things/12?filter=hello%20world'],
      ['POST', '/things'],
      ['GET', '/things/12'],
      ['GET', '/ping'],
    ]).flat()
  );
});

test('the standalone Inventory example has typed interface and provider methods', async t => {
  const spec = parse(await readFile(resolve(project, 'examples/inventory.openapi.yaml'), 'utf8'));
  const result = await generateProvider(spec, options);
  assert.equal(result.operationCount, 3);
  assert.equal(result.schemaCount, 2);
  assert.deepEqual(result.warnings, []);
  await compile(
    t,
    result.code,
    `import {Sample, SampleService} from './provider';
declare const service: Sample;
declare const provider: SampleService;
provider.listItems().then(response => response.body.map(item => item.id));
service.getItem(123).then(response => response.body.name.toUpperCase());
provider.createItem({name: 'Example', price: null});
// @ts-expect-error no legacy ownerId argument
provider.listItems(1);
// @ts-expect-error item name is required
provider.createItem({price: 100});
// @ts-expect-error id is a number
service.getItem('123');
`
  );
});

test('reports unsupported or ambiguous input instead of silently generating broken methods', async () => {
  const cases = [
    [
      s => {
        s.openapi = '3.1.0';
      },
      /OpenAPI 3.0/,
    ],
    [
      s => {
        delete s.paths['/ping'].get.operationId;
      },
      /operationId is required/,
    ],
    [
      s => {
        s.paths['/ping'].get.operationId = 'Things.find';
      },
      /duplicate operationId/,
    ],
    [
      s => {
        s.paths['/ping'].get['x-operation-name'] = 'findThing';
      },
      /duplicate or reserved/,
    ],
    [
      s => {
        s.paths['/ping'].get['x-operation-name'] = 'execute';
      },
      /reserved/,
    ],
    [
      s => {
        s.paths['/ping'].get.operationId = 'Things_find';
      },
      /collide after connector normalization/,
    ],
    [
      s => {
        s.paths['/ping'].get['x-operation-name'] = 'thingsFind';
      },
      /collides with another operation/,
    ],
    [
      s => {
        s.components.schemas.Thing.properties.parent.$ref = './other.json#/Thing';
      },
      /bundle external/,
    ],
    [
      s => {
        s.components.schemas.Thing.properties.parent.$ref = '#/components/schemas/Missing';
      },
      /unresolved reference/,
    ],
    [
      s => {
        s.paths['/things/{id}'].get.parameters.push({name: 'id', in: 'query', schema: {type: 'string'}});
      },
      /duplicate parameter/,
    ],
    [
      s => {
        s.paths['/things/{id}'].parameters[0].required = false;
      },
      /must be required/,
    ],
  ];
  for (const [edit, message] of cases) {
    const spec = fixture();
    edit(spec);
    await assert.rejects(generateProvider(spec, options), message);
  }
  await assert.rejects(generateProvider(fixture(), {...options, name: 'bad-name'}), /Invalid or conflicting/);
  for (const methodName of ['value', 'dataSource']) {
    const spec = fixture();
    spec.paths['/ping'].get['x-operation-name'] = methodName;
    await assert.rejects(generateProvider(spec, options), /reserved/);
  }
});

test('optional trailing body, escaped identifiers, multiple media types and success codes compile', async t => {
  const spec = fixture();
  spec.paths['/things'].post.requestBody = {content: json({type: 'string'})};
  spec.paths['/ping'].get['x-operation-name'] = 'say-"hi"';
  spec.paths['/ping'].get.responses = {
    200: {description: 'one', content: {...json({type: 'boolean'}), 'text/plain': {schema: {type: 'string'}}}},
    '2XX': {description: 'two', content: json({type: 'integer'})},
  };
  await compile(
    t,
    (await generateProvider(spec, options)).code,
    `import {Sample} from './provider';
declare const service: Sample;
service.createThing();
service.createThing('body');
service['say-"hi"']().then(res => {const body: string | number | boolean = res.body;});
`
  );
});
