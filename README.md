# lb4-openapi-provider-gen

Generate typed **LoopBack 4 service providers** from OpenAPI 3.0 JSON or YAML.
One generated TypeScript file contains a service interface, a provider class
with callable API methods, and schema/request/response types.

The generator uses `openapi-typescript` for wire types and adapts the result to
`@loopback/service-proxy` and `loopback-connector-openapi`.

## Install

Requires Node.js 22 or later. After the package is published:

```sh
npm install --save-dev lb4-openapi-provider-gen
```

The application receiving the provider needs `@loopback/core`,
`@loopback/service-proxy` and `loopback-connector-openapi`, plus an existing
OpenAPI datasource. The generator does not install application dependencies.

## Generate a provider

```sh
npx lb4-openapi-provider-gen ./openapi.yaml \
  --name Inventory \
  --datasource-class InventoryDataSource \
  --datasource-import ../datasources/inventory.datasource \
  --binding datasources.Inventory \
  --output src/services/inventory.service.ts
```

The datasource import is relative to the **generated file**. Input and output
paths are relative to the working directory. Without `--output`, code goes to
stdout and diagnostics to stderr. Existing output requires `--force`.

Use `--check` to detect drift without writing, with the same flags used to
generate the file:

```sh
npx lb4-openapi-provider-gen ./openapi.yaml --name Inventory \
  --datasource-import ../datasources/inventory.datasource \
  --output src/services/inventory.service.ts --check
```

| Option                 | Default / behavior                                                |
| ---------------------- | ----------------------------------------------------------------- |
| `--name`, `-n`         | Service interface; PascalCase of the input filename               |
| `--output`, `-o`       | Write one `.ts` file; otherwise stdout                            |
| `--provider-class`     | `<name>Service`                                                   |
| `--datasource-class`   | `<name>DataSource`                                                |
| `--datasource-import`  | `../datasources`                                                  |
| `--binding`            | `datasources.<name>`                                              |
| `--response raw\|body` | `raw` returns the connector response, including `.body`           |
| `--force`, `-f`        | Replace existing output using an atomic rename                    |
| `--check`              | Compare without writing; exit 1 if output is missing or different |
| `--help`, `-h`         | Usage                                                             |
| `--version`, `-v`      | Version                                                           |

Generation replaces the entire file. Keep custom DTOs, runtime decorators and
application logic in separate modules.

## Use the generated service

Your datasource must have `positional: true` and use the connector's default
method mapping. It remains responsible for the spec, server URL, credentials,
HTTP client and error handling. See the [example datasource](examples/inventory.datasource.ts).

```ts
import {service} from '@loopback/core';
import {InventoryService} from './inventory.service';

export class InventoryConsumer {
  constructor(@service(InventoryService) private inventory: InventoryService) {}

  async names() {
    const response = await this.inventory.listItems();
    return response.body.map(item => item.name);
  }
}
```

You can also annotate the injected value as `Inventory`, the generated service
interface. LoopBack injects the proxy returned by `value()`. The provider class
also implements forwarding methods, so `new InventoryService(datasource).getItem(123)`
works directly. Both patterns enforce the same argument and response types.

The default return type is `Promise<OpenApiResponse<T>>`, matching a datasource
with `transformResponse` unset. If it uses `transformResponse: true`, generate
with `--response body` for `Promise<T>` results. The flag changes generated
types, not datasource settings. Custom transformers need corresponding types.

Method names use `x-operation-name` when present, otherwise the normalized
`operationId` (`Health.ping` becomes `Health_ping`). Parameter order follows the
connector: operation parameters, inherited path parameters, then request body.
An optional connector options object is always last. Pass `undefined` when
omitting positional arguments before later arguments.

Output includes component aliases (`Item`), operation aliases
(`CreateItemRequest`, `CreateItemResponse`) and complete wire types in
`InventorySchema`. These are compile-time types, not decorated classes or runtime
validators. Dates remain strings. Type names that collide with generated symbols
receive numeric suffixes.

## Programmatic API

The package exports an ESM API with TypeScript declarations:

```ts
import {readFile, writeFile} from 'node:fs/promises';
import {generateProvider, type GeneratorOptions} from 'lb4-openapi-provider-gen';

const spec = JSON.parse(await readFile('openapi.json', 'utf8'));
const options: GeneratorOptions = {
  name: 'Inventory',
  datasourceImport: '../datasources/inventory.datasource',
};
const result = await generateProvider(spec, options);
await writeFile('inventory.service.ts', result.code);
console.log(result.operationCount, result.schemaCount, result.warnings);
```

The CLI handles YAML parsing and protected writes. The library accepts a parsed
document and returns `{code, operationCount, schemaCount, warnings}`.

## Supported input

- Local OpenAPI **3.0.x** JSON/YAML with unique `operationId` values.
- Document-local `$ref`s, including recursive schemas and referenced parameters,
  request bodies and responses. Bundle external references first.
- Arrays, required/optional properties, enums, nullable values, composition
  (`allOf`, `oneOf`, `anyOf`), dictionaries and inline schemas.
- Response types combine declared 2xx statuses and media types. HEAD/204/205
  bodies are `undefined`. Missing success-body schemas produce `unknown` and a
  warning. Error responses are not part of the resolved success type.

Swagger 2, OpenAPI 3.1, path-item references, ambiguous method names and duplicate
parameter names across locations are rejected. Provider members `value` and
`dataSource` are reserved. The tool generates providers, not datasources or
credentials, and does not call the external service during generation.

## Develop

```sh
npm ci
npm test
npm run generate:example
npm run check:example
npm run test:package
```

Try `node dist/cli.js --help` after `npm run build`. The source repository includes
an [Inventory schema](examples/inventory.openapi.yaml) and generated
[provider](examples/inventory.service.ts).

Tests compile generated TypeScript, check invalid calls, exercise providers and
LoopBack injection against a local HTTP server, and verify CLI writes and drift
detection. `test:package` installs the tarball in an isolated project with
production dependencies and checks its binary, generation, ESM entry point and
declarations.

See [RELEASING.md](RELEASING.md) for GitHub setup, npm bootstrap and trusted
publishing. The initial version is `0.1.0`; preparation does not publish it.

## License

[MIT](LICENSE), copyright Adam Šmíd.

Reference documentation: [LoopBack OpenAPI connector](https://loopback.io/doc/en/lb3/OpenAPI-connector.html)
and [openapi-typescript Node API](https://openapi-ts.dev/node).
