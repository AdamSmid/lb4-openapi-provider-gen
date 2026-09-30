import openapiTS, {astToString} from 'openapi-typescript';
import ts from 'typescript';
import camelCase from 'lodash/camelCase.js';

type JsonObject = Record<string, unknown>;

export interface GeneratorOptions {
  /** Exported service interface, e.g. Inventory. */
  name: string;
  providerClass?: string;
  datasourceClass?: string;
  datasourceImport?: string;
  binding?: string;
  /** Must agree with the datasource's transformResponse setting. */
  response?: 'raw' | 'body';
}

export interface GeneratorResult {
  code: string;
  operationCount: number;
  schemaCount: number;
  warnings: string[];
}

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const reserved = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield any boolean constructor declare get module require number set string symbol type from of unknown never object async await arguments eval undefined'.split(
    ' '
  )
);
const q = (value: string): string => JSON.stringify(value);

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function identifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value) && !reserved.has(value);
}

export function pascalCase(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean);
  const name = words.map(word => word[0].toUpperCase() + word.slice(1)).join('') || 'Api';
  return /^\d/.test(name) ? `Api${name}` : name;
}

function uniqueName(value: string, used: Set<string>): string {
  const base = identifier(value) ? value : pascalCase(value);
  let name = base;
  for (let suffix = 2; used.has(name) || !identifier(name); suffix++) name = `${base}${suffix}`;
  used.add(name);
  return name;
}

function resolveRef(spec: JsonObject, value: unknown, context: string, seen = new Set<string>()): JsonObject {
  const node = object(value, context);
  if (node.$ref === undefined) return node;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`${context}: only document-local $refs are supported; bundle external references first.`);
  }
  if (seen.has(ref)) throw new Error(`${context}: circular non-schema reference ${ref}.`);
  seen.add(ref);
  let target: unknown = spec;
  for (const part of decodeURIComponent(ref.slice(2)).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error(`${context}: unresolved reference ${ref}.`);
    target = (target as JsonObject)[key];
  }
  return resolveRef(spec, target, context, seen);
}

// Check every reference before passing data to the type generator. Generation is offline.
function validateRefs(spec: JsonObject, value: unknown, seen = new Set<object>(), kind: 'node' | 'map' | 'examples' | 'example' = 'node'): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) validateRefs(spec, child, seen);
    return;
  }
  const node = value as JsonObject;
  if (kind !== 'map' && kind !== 'examples' && '$ref' in node) resolveRef(spec, node, 'Specification');
  for (const [key, child] of Object.entries(node)) {
    if (kind === 'map' || kind === 'examples') {
      validateRefs(spec, child, seen, kind === 'examples' ? 'example' : 'node');
      continue;
    }
    // Literal payloads can themselves contain a "$ref" property.
    if (['example', 'default', 'enum'].includes(key) || (kind === 'example' && key === 'value')) continue;
    const maps = ['paths', 'schemas', 'properties', 'responses', 'requestBodies', 'parameters', 'headers', 'links', 'callbacks', 'securitySchemes', 'content'];
    validateRefs(spec, child, seen, key === 'examples' ? 'examples' : maps.includes(key) ? 'map' : 'node');
  }
}

interface Argument {
  name: string;
  type: string;
  required: boolean;
}

export async function generateProvider(input: unknown, options: GeneratorOptions): Promise<GeneratorResult> {
  const spec = object(input, 'Specification');
  if (typeof spec.openapi !== 'string' || !/^3\.0\.\d+$/.test(spec.openapi)) {
    throw new Error('Expected OpenAPI 3.0.x (the LoopBack connector does not support OpenAPI 3.1 or Swagger 2 here).');
  }
  object(spec.info, 'info');
  const paths = object(spec.paths, 'paths');
  validateRefs(spec, spec);

  const name = options.name;
  const provider = options.providerClass ?? `${name}Service`;
  const datasource = options.datasourceClass ?? `${name}DataSource`;
  const namespace = `${name}Schema`;
  const response = options.response ?? 'raw';
  if (!['raw', 'body'].includes(response)) throw new Error('response must be raw or body.');
  const used = new Set(['inject', 'Provider', 'getService', 'OpenApiResponse', 'OpenApiRequestOptions', 'Promise', 'Record', 'NonNullable', 'Parameters', 'ReturnType']);
  for (const symbol of [name, provider, datasource, namespace]) {
    if (!identifier(symbol) || used.has(symbol)) throw new Error(`Invalid or conflicting TypeScript name: ${symbol}`);
    used.add(symbol);
  }

  const warnings: string[] = [];
  const aliases: string[] = [];
  const signatures: string[] = [];
  const forwardingMethods: string[] = [];
  const ids = new Set<string>();
  const normalizedIds = new Set<string>();
  const connectorAliases = new Map<string, Set<string>>();
  const selectedNames = new Map<string, string>();
  // These names are assigned by the connector itself or inherited from Function.
  const reservedMethods = new Set([
    'execute',
    'apis',
    'then',
    'constructor',
    '__proto__',
    'prototype',
    'length',
    'name',
    'caller',
    'arguments',
    'bind',
    'call',
    'apply',
    'toString',
    'value',
    'dataSource',
  ]);
  const operationNames = new Set(reservedMethods);
  const components = spec.components === undefined ? {} : object(spec.components, 'components');
  const schemas = components.schemas === undefined ? {} : object(components.schemas, 'components.schemas');
  for (const key of Object.keys(schemas)) {
    const alias = uniqueName(key, used);
    aliases.push(`export type ${alias} = ${namespace}.components["schemas"][${q(key)}];`);
  }

  for (const [path, rawItem] of Object.entries(paths)) {
    if (path.startsWith('x-')) continue;
    const item = object(rawItem, `Path ${path}`);
    if (item.$ref) throw new Error(`${path}: path-item $refs must be inlined for the LoopBack connector.`);
    for (const method of methods) {
      if (item[method] === undefined) continue;
      const context = `${method.toUpperCase()} ${path}`;
      const op = object(item[method], context);
      const id = op.operationId;
      if (typeof id !== 'string' || !id.trim()) throw new Error(`${context}: operationId is required.`);
      if (ids.has(id)) throw new Error(`${context}: duplicate operationId ${id}.`);
      ids.add(id);
      // Swagger-client normalizes operationId in-place before LoopBack maps methods.
      const normalizedId = id.replace(/\W/g, '_');
      if (normalizedIds.has(normalizedId)) throw new Error(`${context}: operationIds collide after connector normalization: ${normalizedId}.`);
      normalizedIds.add(normalizedId);
      const methodName = op['x-operation-name'] ?? normalizedId;
      if (typeof methodName !== 'string' || !methodName.trim()) throw new Error(`${context}: invalid x-operation-name.`);
      if (operationNames.has(methodName)) throw new Error(`${context}: duplicate or reserved connector method ${methodName}. Use unique x-operation-name values.`);
      operationNames.add(methodName);
      selectedNames.set(methodName, id);
      if (op.tags !== undefined && (!Array.isArray(op.tags) || op.tags.some(tag => typeof tag !== 'string'))) {
        throw new Error(`${context}: tags must be an array of strings.`);
      }
      const tags = (op.tags as string[] | undefined)?.length ? (op.tags as string[]) : ['default'];
      const aliasesForOperation = [normalizedId, camelCase(normalizedId)];
      if (op['x-operation-name']) aliasesForOperation.push(methodName, camelCase(methodName));
      for (const tag of tags) {
        aliasesForOperation.push(`${tag}_${normalizedId}`);
        if (op['x-operation-name']) aliasesForOperation.push(`${tag}_${methodName}`, camelCase(`${tag}_${methodName}`));
      }
      for (const alias of aliasesForOperation) {
        if (reservedMethods.has(alias)) throw new Error(`${context}: reserved connector alias ${alias}. Choose a different operationId or x-operation-name.`);
        const owners = connectorAliases.get(alias) ?? new Set<string>();
        owners.add(id);
        connectorAliases.set(alias, owners);
      }
      const operationType = `${namespace}.operations[${q(id)}]`;
      const args: Argument[] = [];
      const argNames = new Set(['options']);
      if (op.parameters !== undefined && !Array.isArray(op.parameters)) throw new Error(`${context}: parameters must be an array.`);
      const params = ((op.parameters as unknown[] | undefined) ?? []).map(p => resolveRef(spec, p, context));
      if (item.parameters !== undefined && !Array.isArray(item.parameters)) throw new Error(`${path}: parameters must be an array.`);
      for (const raw of (item.parameters as unknown[] | undefined) ?? []) {
        const inherited = resolveRef(spec, raw, context);
        const override = params.find(p => p.name === inherited.name);
        if (override && override.in !== inherited.in) throw new Error(`${context}: duplicate parameter name ${String(inherited.name)} across locations.`);
        // Swagger-client appends inherited parameters after operation parameters.
        if (!override) params.push(inherited);
      }
      const wireNames = new Set<string>();
      for (const parameter of params) {
        const paramName = parameter.name;
        const location = parameter.in;
        if (typeof paramName !== 'string' || !['query', 'path', 'header', 'cookie'].includes(String(location))) {
          throw new Error(`${context}: invalid parameter name or location.`);
        }
        if (wireNames.has(paramName)) throw new Error(`${context}: duplicate parameter name ${paramName}; the positional connector cannot distinguish locations.`);
        if (paramName === 'requestBody') throw new Error(`${context}: requestBody is reserved by the positional connector.`);
        wireNames.add(paramName);
        if (location === 'path' && parameter.required !== true) throw new Error(`${context}: path parameter ${paramName} must be required.`);
        args.push({
          name: uniqueName(paramName, argNames),
          type: `NonNullable<${operationType}["parameters"][${q(String(location))}]>[${q(paramName)}]`,
          required: parameter.required === true,
        });
      }
      if (op.requestBody !== undefined) {
        const body = resolveRef(spec, op.requestBody, `${context} requestBody`);
        const content = object(body.content, `${context} requestBody.content`);
        if (!Object.keys(content).length) throw new Error(`${context}: requestBody.content must not be empty.`);
        const alias = uniqueName(`${pascalCase(methodName)}Request`, used);
        aliases.push(`export type ${alias} = NonNullable<${operationType}["requestBody"]>["content"][keyof NonNullable<${operationType}["requestBody"]>["content"]];`);
        args.push({name: uniqueName('requestBody', argNames), type: alias, required: body.required === true});
      }

      const responses = object(op.responses, `${context} responses`);
      const successTypes: string[] = [];
      for (const [status, rawResponse] of Object.entries(responses)) {
        if (!/^2(?:\d{2}|XX)$/.test(status)) continue;
        const res = resolveRef(spec, rawResponse, `${context} response ${status}`);
        const content = res.content === undefined ? {} : object(res.content, `${context} response content`);
        if (['204', '205'].includes(status) || method === 'head') {
          successTypes.push('undefined');
        } else if (!Object.keys(content).length) {
          successTypes.push('unknown');
          warnings.push(`${context} response ${status} has no body schema; using unknown.`);
        } else {
          const type = `${operationType}["responses"][${/^\d+$/.test(status) ? status : q(status)}]["content"]`;
          successTypes.push(`${type}[keyof ${type}]`);
        }
      }
      if (!successTypes.length) {
        successTypes.push('unknown');
        warnings.push(`${context} has no explicit 2xx response; using unknown.`);
      }
      const result = uniqueName(`${pascalCase(methodName)}Response`, used);
      aliases.push(`export type ${result} = ${[...new Set(successTypes)].join(' | ')};`);
      const lastRequired = args.reduce((last, arg, index) => (arg.required ? index : last), -1);
      const parameters = args.map((arg, index) => {
        const optional = !arg.required && index > lastRequired;
        const type = !arg.required && !optional ? `(${arg.type}) | undefined` : arg.type;
        return `${arg.name}${optional ? '?' : ''}: ${type}`;
      });
      parameters.push('options?: OpenApiRequestOptions');
      signatures.push(
        `  /** ${context.replace(/\*\//g, '* /').replace(/[\r\n\u2028\u2029]/g, ' ')} */\n  ${q(methodName)}(${parameters.join(', ')}): Promise<${response === 'raw' ? `OpenApiResponse<${result}>` : result}>;`
      );
      forwardingMethods.push(`  async ${q(methodName)}(...args: Parameters<${name}[${q(methodName)}]>): ReturnType<${name}[${q(methodName)}]> {
    return (await this.value())[${q(methodName)}](...args);
  }`);
    }
  }
  if (!signatures.length) throw new Error('The specification contains no HTTP operations.');
  for (const [methodName, id] of selectedNames) {
    if ([...(connectorAliases.get(methodName) ?? [])].some(owner => owner !== id)) {
      throw new Error(`Connector method ${methodName} collides with another operation's alias. Use unique operationId and x-operation-name values.`);
    }
  }

  const schemaTypes = astToString(await openapiTS(JSON.stringify(spec), {silent: true, defaultNonNullable: false}));
  const code = `// Generated by lb4-openapi-provider-gen. Do not edit by hand.
// Requires a LoopBack OpenAPI datasource with positional: true.
// Response mode: ${response}${response === 'body' ? ' (requires transformResponse: true)' : ' (leave transformResponse unset)'}.
import {inject, Provider} from '@loopback/core';
import {getService} from '@loopback/service-proxy';
import {${datasource}} from ${q(options.datasourceImport ?? '../datasources')};

/** Swagger-client response returned by the OpenAPI connector. */
export interface OpenApiResponse<T> {
  body: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  ok: boolean;
  text?: string;
}

/** Extra connector options, passed after all positional arguments. */
export interface OpenApiRequestOptions {
  requestContentType?: string;
  responseContentType?: string;
  [key: string]: unknown;
}

export interface ${name} {
${signatures.join('\n\n')}
}

export class ${provider} implements Provider<${name}>, ${name} {
  constructor(
    @inject(${q(options.binding ?? `datasources.${name}`)})
    protected dataSource: ${datasource} = new ${datasource}(),
  ) {}

  value(): Promise<${name}> {
    return getService<${name}>(this.dataSource);
  }

${forwardingMethods.join('\n\n')}
}

${aliases.join('\n\n')}

/** Full wire types. Dates remain strings; these are not runtime model classes. */
export namespace ${namespace} {
${schemaTypes
  .split('\n')
  .map(line => (line ? `  ${line}` : ''))
  .join('\n')}
}
`;
  // A single generated file is easy to move, review and replace atomically.
  const source = ts.createSourceFile('provider.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return {
    code: ts.createPrinter({newLine: ts.NewLineKind.LineFeed}).printFile(source),
    operationCount: signatures.length,
    schemaCount: Object.keys(schemas).length,
    warnings,
  };
}
