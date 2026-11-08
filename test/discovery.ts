import { readFileSync } from 'node:fs';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema;
  enum?: string[];
  deprecated?: boolean;
};
type Parameter = Schema & { location: string; required?: boolean };
type ApiMethod = {
  httpMethod: string;
  path: string;
  flatPath?: string;
  deprecated?: boolean;
  parameters?: Record<string, Parameter>;
  request?: Schema;
  mediaUpload?: { protocols: { simple?: { path: string } } };
};
type Resource = { methods?: Record<string, ApiMethod>; resources?: Record<string, Resource> };
type Document = {
  id: string;
  rootUrl: string;
  servicePath: string;
  parameters: Record<string, Parameter>;
  schemas: Record<string, Schema>;
  resources: Record<string, Resource>;
};
type Route = { document: Document; method: ApiMethod; template: string; pattern: RegExp };

const DOCUMENTS = ['androidpublisher', 'playdeveloperreporting'].map(loadDocument);
const ROUTES = DOCUMENTS.flatMap((document) =>
  Object.values(document.resources).flatMap((resource) => routesOf(document, resource)),
);

export function specViolations(method: Method, url: URL, body?: unknown): string[] {
  const candidates = ROUTES.filter(
    (route) =>
      route.document.rootUrl === `${url.origin}/` &&
      route.pattern.test(url.pathname) &&
      route.method.httpMethod === method,
  ).sort((a, b) => literalLength(b.template) - literalLength(a.template));
  const route = candidates[0];
  if (route === undefined) {
    return [`${method} ${url.pathname} は、仕様に無い操作です`];
  }
  const where = `${method} ${route.template}`;
  const violations: string[] = [];
  if (route.method.deprecated === true) {
    violations.push(`${where} は、仕様で deprecated です`);
  }
  const parameters = { ...route.document.parameters, ...route.method.parameters };
  for (const [name, value] of url.searchParams) {
    const parameter = parameters[name];
    if (parameter === undefined || parameter.location !== 'query') {
      violations.push(`${where} に、引数 ${name} はありません`);
      continue;
    }
    violations.push(...parameterViolations(name, value, parameter));
  }
  const captured = route.pattern.exec(url.pathname)?.groups ?? {};
  for (const [name, value] of Object.entries(captured)) {
    const parameter = route.method.parameters?.[name];
    if (parameter !== undefined) {
      violations.push(...parameterViolations(name, decodeURIComponent(value), parameter));
    }
  }
  if (isMediaUpload(route)) {
    return violations;
  }
  if (route.method.request === undefined) {
    if (body !== undefined) {
      violations.push(`${where} は、本文を受け取りません`);
    }
    return violations;
  }
  if (body === undefined) {
    violations.push(`${where} には、本文が要ります`);
    return violations;
  }
  return [...violations, ...schemaViolations(route.document, route.method.request, body, '本文')];
}

// 仕様のすべてのメソッドの ID を返す（API に操作が足されたら気付くため）
export function apiMethodIds(): string[] {
  const walk = (prefix: string, resource: Resource): string[] => [
    ...Object.keys(resource.methods ?? {}).map((name) => `${prefix}.${name}`),
    ...Object.entries(resource.resources ?? {}).flatMap(([name, child]) =>
      walk(`${prefix}.${name}`, child),
    ),
  ];
  return DOCUMENTS.flatMap((document) =>
    Object.entries(document.resources).flatMap(([name, resource]) =>
      walk(`${document.id}.${name}`, resource),
    ),
  );
}

function loadDocument(name: string): Document {
  const path = new URL(`../.local/${name}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Document;
  } catch (error) {
    throw new Error(
      `Google の API の仕様 ${path.pathname} を読めません。make download-discovery で落としてください。`,
      { cause: error },
    );
  }
}

function routesOf(document: Document, resource: Resource): Route[] {
  return [
    ...Object.values(resource.methods ?? {}).flatMap((method) => {
      const simpleUpload = method.mediaUpload?.protocols.simple?.path;
      return [
        ...[method.flatPath ?? method.path].map((path) => route(document, method, path)),
        ...(simpleUpload === undefined ? [] : [route(document, method, simpleUpload)]),
      ];
    }),
    ...Object.values(resource.resources ?? {}).flatMap((child) => routesOf(document, child)),
  ];
}

function route(document: Document, method: ApiMethod, path: string): Route {
  const template = path.startsWith('/') ? path : `/${path}`;
  const pattern = new RegExp(
    `^${template
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{\+?(\w+)\}/g, (_, name: string) => `(?<${name}>[^/]+)`)}$`,
  );
  return { document, method, template, pattern };
}

function isMediaUpload(route: Route): boolean {
  return route.template.startsWith('/upload/');
}

function literalLength(template: string): number {
  return template.replace(/\{[^}]+\}/g, '').length;
}

function parameterViolations(name: string, value: string, parameter: Parameter): string[] {
  if (parameter.enum !== undefined && !parameter.enum.includes(value)) {
    return [`引数 ${name} に ${value} は使えません`];
  }
  if (parameter.type === 'boolean' && value !== 'true' && value !== 'false') {
    return [`引数 ${name} は真偽値です`];
  }
  if (parameter.type === 'integer' && !Number.isInteger(Number(value))) {
    return [`引数 ${name} は整数です`];
  }
  return parameter.deprecated === true ? [`引数 ${name} は、仕様で deprecated です`] : [];
}

// Discovery の JSON Schema では名前の打ち間違いが通るので、仕様に無い名前も挙げる
function schemaViolations(
  document: Document,
  schema: Schema,
  value: unknown,
  at: string,
): string[] {
  const resolved = schema.$ref === undefined ? schema : (document.schemas[schema.$ref] ?? {});
  if (resolved.deprecated === true) {
    return [`${at} は、仕様で使わないことになっています`];
  }
  if (resolved.enum !== undefined) {
    return typeof value === 'string' && resolved.enum.includes(value)
      ? []
      : [`${at} に ${JSON.stringify(value)} は使えません`];
  }
  switch (resolved.type) {
    case 'object':
      return objectViolations(document, resolved, value, at);
    case 'array':
      return Array.isArray(value)
        ? value.flatMap((item, index) =>
            schemaViolations(document, resolved.items ?? {}, item, `${at}[${index}]`),
          )
        : [`${at} は配列です`];
    case 'string':
      return typeof value === 'string' ? [] : [`${at} は文字列です`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at} は真偽値です`];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at} は整数です`];
    case 'number':
      return typeof value === 'number' ? [] : [`${at} は数です`];
    default:
      return [];
  }
}

function objectViolations(
  document: Document,
  schema: Schema,
  value: unknown,
  at: string,
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${at} はオブジェクトです`];
  }
  return Object.entries(value).flatMap(([name, item]) => {
    const property = schema.properties?.[name] ?? schema.additionalProperties;
    return property === undefined
      ? [`${at}.${name} は、仕様にありません`]
      : schemaViolations(document, property, item, `${at}.${name}`);
  });
}
