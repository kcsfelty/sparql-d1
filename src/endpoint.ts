import type { QueryEngine } from '@comunica/query-sparql/lib/QueryEngine.js';
import type * as RDF from '@rdfjs/types';
import { translate } from 'sparqlalgebrajs';
import { D1QuadSource, D1QuadStore } from './d1-source.js';
import type { D1QuadSourceOptions, QueryObservation } from './d1-source.js';
import type { D1DatabaseLike } from './d1-types.js';

const QUERY_RESULT_MEDIA_TYPES = [
  'application/sparql-results+json',
  'application/sparql-results+xml',
  'text/csv',
  'text/tab-separated-values',
] as const;

const RDF_MEDIA_TYPES = [
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'application/ld+json',
] as const;

const UPDATE_OPERATIONS = new Set([
  'add',
  'clear',
  'copy',
  'create',
  'deleteinsert',
  'drop',
  'load',
  'move',
]);

export interface SparqlRequestObservation {
  durationMs: number;
  queryBytes: number;
  status: number;
  resultType?: string;
  mediaType?: string;
  error?: string;
}

export type ServicePolicy = (
  serviceIri: URL,
  request: Request,
) => boolean | Promise<boolean>;

export interface D1SourceFactoryOptions extends D1QuadSourceOptions {
  readOnly: boolean;
}

export type D1SourceFactory = (
  db: D1DatabaseLike,
  options: D1SourceFactoryOptions,
) => RDF.Source;

export interface SparqlHandlerOptions {
  db: D1DatabaseLike;
  sourceFactory?: D1SourceFactory;
  sourcePageSize?: number;
  engine?: QueryEngine | Promise<QueryEngine>;
  authenticate?: (
    request: Request,
  ) => boolean | Response | Promise<boolean | Response>;
  rateLimit?: (
    request: Request,
  ) => Response | null | undefined | Promise<Response | null | undefined>;
  readOnly?: boolean;
  servicePolicy?: ServicePolicy;
  serviceFetch?: typeof globalThis.fetch;
  maxQueryBytes?: number;
  maxResultBytes?: number;
  maxAlgebraDepth?: number;
  maxAlgebraOperations?: number;
  timeoutMs?: number;
  exposeErrors?: boolean;
  observe?: (observation: SparqlRequestObservation) => void;
  observeD1?: (observation: QueryObservation) => void;
}

interface Limits {
  maxQueryBytes: number;
  maxResultBytes: number;
  maxAlgebraDepth: number;
  maxAlgebraOperations: number;
  timeoutMs: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createSparqlHandler(options: SparqlHandlerOptions) {
  let defaultEngine: Promise<QueryEngine> | undefined;
  const getEngine = () => {
    if (options.engine) {
      return Promise.resolve(options.engine);
    }
    defaultEngine ??= loadDefaultEngine();
    return defaultEngine;
  };
  const readOnly = options.readOnly ?? true;
  const sourceOptions = {
    readOnly,
    ...(options.observeD1 ? { observe: options.observeD1 } : {}),
    ...(options.sourcePageSize === undefined
      ? {}
      : { pageSize: options.sourcePageSize }),
  };
  const source = options.sourceFactory
    ? options.sourceFactory(options.db, sourceOptions)
    : readOnly
      ? new D1QuadSource(options.db, sourceOptions)
      : new D1QuadStore(options.db, sourceOptions);
  const exposeErrors = options.exposeErrors ?? false;
  const limits: Limits = {
    maxQueryBytes: options.maxQueryBytes ?? 16 * 1024,
    maxResultBytes: options.maxResultBytes ?? 5 * 1024 * 1024,
    maxAlgebraDepth: options.maxAlgebraDepth ?? 40,
    maxAlgebraOperations: options.maxAlgebraOperations ?? 250,
    timeoutMs: options.timeoutMs ?? 10_000,
  };

  return async function handleSparql(request: Request): Promise<Response> {
    const started = performance.now();
    let queryBytes = 0;
    let resultType: string | undefined;
    let mediaType: string | undefined;

    try {
      const rateLimitResponse = await options.rateLimit?.(request);
      if (rateLimitResponse instanceof Response) {
        observe(options, started, queryBytes, rateLimitResponse.status);
        return rateLimitResponse;
      }
      const authResult = await options.authenticate?.(request);
      if (authResult instanceof Response) {
        observe(options, started, queryBytes, authResult.status);
        return authResult;
      }
      if (authResult === false) {
        throw new HttpError(401, 'Unauthorized');
      }

      const deadline = performance.now() + limits.timeoutMs;
      const { query, operation } = await withDeadline(
        extractQuery(request, readOnly, limits.maxQueryBytes),
        deadline,
        request.signal,
      );
      queryBytes = new TextEncoder().encode(query).byteLength;
      if (queryBytes > limits.maxQueryBytes) {
        throw new HttpError(
          413,
          'SPARQL query exceeds the configured size limit',
        );
      }

      const context = { sources: [source], readOnly };
      const parsed = translate(query, { quads: true });
      assertActiveDeadline(deadline, request.signal);
      const analysis = analyzeAlgebra(parsed);

      if (analysis.operations > limits.maxAlgebraOperations) {
        throw new HttpError(422, 'SPARQL query contains too many operations');
      }
      if (analysis.depth > limits.maxAlgebraDepth) {
        throw new HttpError(422, 'SPARQL query is nested too deeply');
      }
      const isUpdate = [...analysis.types].some((type) =>
        UPDATE_OPERATIONS.has(type),
      );
      if (operation === 'query' && isUpdate) {
        throw new HttpError(
          400,
          'SPARQL Update requires the update POST operation',
        );
      }
      if (operation === 'update' && !isUpdate) {
        throw new HttpError(400, 'SPARQL query requires the query operation');
      }
      if (analysis.types.has('load')) {
        throw new HttpError(
          403,
          'Remote SPARQL LOAD is disabled; import RDF through a trusted application path',
        );
      }
      if (analysis.types.has('service')) {
        await withDeadline(
          authorizeServices(
            analysis.serviceTargets,
            options.servicePolicy,
            request,
          ),
          deadline,
          request.signal,
        );
      }
      if (readOnly && isUpdate) {
        throw new HttpError(403, 'SPARQL Update is disabled');
      }

      const engine = await withDeadline(getEngine(), deadline, request.signal);
      const queryContext = {
        ...context,
        httpAbortSignal: request.signal,
        ...(options.servicePolicy
          ? {
              fetch: policyFetch(
                options.servicePolicy,
                request,
                options.serviceFetch ?? globalThis.fetch.bind(globalThis),
              ),
            }
          : {}),
      };
      const result = await withDeadline(
        engine.query(query, queryContext),
        deadline,
        request.signal,
      );
      resultType = result.resultType;

      if (result.resultType === 'void') {
        await withDeadline(result.execute(), deadline, request.signal);
        observe(options, started, queryBytes, 204, resultType);
        return new Response(null, { status: 204 });
      }

      const available = await withDeadline(
        engine.getResultMediaTypes(queryContext),
        deadline,
        request.signal,
      );
      mediaType = negotiateMediaType(
        request.headers.get('accept'),
        result.resultType,
        new Set(Object.keys(available)),
      );
      const serializedData =
        mediaType === 'application/sparql-results+xml' &&
        (result.resultType === 'bindings' || result.resultType === 'boolean')
          ? serializeSparqlXml(result)
          : (
              await withDeadline(
                engine.resultToString(
                  result as RDF.Query<unknown>,
                  mediaType,
                  queryContext,
                ),
                deadline,
                request.signal,
              )
            ).data;
      assertActiveDeadline(deadline, request.signal);
      const body = toWebStream(serializedData, {
        deadline,
        maxBytes: limits.maxResultBytes,
        signal: request.signal,
      });
      const response = new Response(body, {
        status: 200,
        headers: {
          'content-type': `${mediaType}; charset=utf-8`,
          vary: 'Accept',
          'x-content-type-options': 'nosniff',
        },
      });
      observe(options, started, queryBytes, 200, resultType, mediaType);
      return response;
    } catch (error) {
      const httpError = normalizeError(error);
      observe(
        options,
        started,
        queryBytes,
        httpError.status,
        resultType,
        mediaType,
        httpError.message,
      );
      return Response.json(
        {
          error:
            exposeErrors || httpError.status < 500
              ? httpError.message
              : 'SPARQL query execution failed',
        },
        {
          status: httpError.status,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
  };
}

async function loadDefaultEngine(): Promise<QueryEngine> {
  const runtime = globalThis as typeof globalThis & { __dirname?: string };
  runtime.__dirname ??= '/';
  const { QueryEngine: DefaultQueryEngine } =
    await import('@comunica/query-sparql/lib/QueryEngine.js');
  return new DefaultQueryEngine();
}

async function extractQuery(
  request: Request,
  readOnly: boolean,
  maxBodyBytes: number,
): Promise<{ query: string; operation: 'query' | 'update' }> {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const update = url.searchParams.get('update');
    if (update !== null) {
      throw new HttpError(405, 'SPARQL Update requires POST');
    }
    const query = url.searchParams.get('query');
    if (!query) {
      throw new HttpError(400, 'Missing SPARQL query');
    }
    return { query, operation: 'query' };
  }

  if (request.method !== 'POST') {
    throw new HttpError(405, 'Only GET and POST are supported');
  }

  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim();
  if (contentType === 'application/sparql-query') {
    return {
      query: await readRequestBody(request, maxBodyBytes),
      operation: 'query',
    };
  }
  if (contentType === 'application/sparql-update') {
    if (readOnly) {
      throw new HttpError(403, 'SPARQL Update is disabled');
    }
    return {
      query: await readRequestBody(request, maxBodyBytes),
      operation: 'update',
    };
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(
      await readRequestBody(request, maxBodyBytes),
    );
    const query = form.get('query');
    const update = form.get('update');
    if (query !== null && update !== null) {
      throw new HttpError(400, 'Choose either query or update, not both');
    }
    if (update !== null && readOnly) {
      throw new HttpError(403, 'SPARQL Update is disabled');
    }
    const operation = update !== null ? 'update' : 'query';
    const text = query ?? update;
    if (!text) {
      throw new HttpError(400, 'Missing SPARQL query');
    }
    return { query: text, operation };
  }
  throw new HttpError(415, 'Unsupported SPARQL request content type');
}

async function readRequestBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (/^\d+$/u.test(contentLength ?? '') && Number(contentLength) > maxBytes) {
    await request.body?.cancel();
    throw new HttpError(413, 'SPARQL query exceeds the configured size limit');
  }
  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(
          413,
          'SPARQL query exceeds the configured size limit',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function analyzeAlgebra(value: unknown): {
  depth: number;
  operations: number;
  types: Set<string>;
  serviceTargets: Array<string | null>;
} {
  const types = new Set<string>();
  const serviceTargets: Array<string | null> = [];
  let operations = 0;
  let maximumDepth = 0;

  const visit = (current: unknown, depth: number): void => {
    maximumDepth = Math.max(maximumDepth, depth);
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!current || typeof current !== 'object') {
      return;
    }
    const record = current as Record<string, unknown>;
    if (
      typeof record.type === 'string' &&
      typeof record.termType !== 'string'
    ) {
      operations += 1;
      types.add(record.type);
      if (record.type === 'service') {
        const name = record.name as Record<string, unknown> | undefined;
        serviceTargets.push(
          name?.termType === 'NamedNode' && typeof name.value === 'string'
            ? name.value
            : null,
        );
      }
    }
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };

  visit(value, 1);
  return { depth: maximumDepth, operations, types, serviceTargets };
}

async function authorizeServices(
  targets: ReadonlyArray<string | null>,
  policy: ServicePolicy | undefined,
  request: Request,
): Promise<void> {
  if (!policy || !targets.length) {
    throw new HttpError(403, 'Federated SERVICE clauses are disabled');
  }
  for (const target of targets) {
    if (!target) {
      throw new HttpError(403, 'Dynamic SERVICE targets are not allowed');
    }
    await authorizeServiceTarget(new URL(target), policy, request);
  }
}

async function authorizeServiceTarget(
  url: URL,
  policy: ServicePolicy,
  request: Request,
): Promise<void> {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !(await policy(url, request))
  ) {
    throw new HttpError(403, 'Federated SERVICE target is not allowed');
  }
}

function policyFetch(
  policy: ServicePolicy,
  request: Request,
  transport: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    await authorizeServiceTarget(url, policy, request);
    const response = await transport(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new HttpError(403, 'Federated SERVICE redirects are disabled');
    }
    return response;
  };
}

export function allowServiceUrls(urls: Iterable<string | URL>): ServicePolicy {
  const allowed = new Set([...urls].map((url) => new URL(url).href));
  return (serviceIri) => allowed.has(serviceIri.href);
}

function negotiateMediaType(
  accept: string | null,
  resultType: string,
  available: Set<string>,
): string {
  const allowed =
    resultType === 'quads' ? RDF_MEDIA_TYPES : QUERY_RESULT_MEDIA_TYPES;
  const fallback =
    resultType === 'quads' ? 'text/turtle' : 'application/sparql-results+json';
  const requested = parseAccept(accept);

  if (!accept?.trim()) {
    if (available.has(fallback)) {
      return fallback;
    }
  }

  const candidates = allowed
    .filter((mediaType) => available.has(mediaType))
    .flatMap((mediaType, serverPreference) => {
      const range = requested
        .filter((item) => mediaRangeMatches(item.mediaType, mediaType))
        .sort(
          (left, right) =>
            right.specificity - left.specificity || left.order - right.order,
        )[0];
      return range && range.quality > 0
        ? [
            {
              mediaType,
              quality: range.quality,
              specificity: range.specificity,
              order: range.order,
              serverPreference,
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        right.quality - left.quality ||
        right.specificity - left.specificity ||
        left.order - right.order ||
        left.serverPreference - right.serverPreference,
    );
  if (candidates[0]) return candidates[0].mediaType;
  throw new HttpError(406, 'No acceptable SPARQL result format is available');
}

function parseAccept(value: string | null): Array<{
  mediaType: string;
  quality: number;
  specificity: number;
  order: number;
}> {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item, order) => {
      const [mediaType = '', ...parameters] = item.trim().split(';');
      const q = parameters.find((parameter) =>
        parameter.trim().startsWith('q='),
      );
      const parsedQuality = q ? Number(q.trim().slice(2)) : 1;
      const normalized = mediaType.trim().toLowerCase();
      return {
        mediaType: normalized,
        quality:
          Number.isFinite(parsedQuality) &&
          parsedQuality >= 0 &&
          parsedQuality <= 1
            ? parsedQuality
            : 0,
        specificity:
          normalized === '*/*' ? 0 : normalized.endsWith('/*') ? 1 : 2,
        order,
      };
    })
    .filter((item) => /^(?:\*|[^/\s]+)\/(?:\*|[^/\s]+)$/u.test(item.mediaType));
}

function mediaRangeMatches(range: string, mediaType: string): boolean {
  const [rangeType, rangeSubtype] = range.split('/');
  const [type, subtype] = mediaType.split('/');
  return (
    (rangeType === '*' || rangeType === type) &&
    (rangeSubtype === '*' || rangeSubtype === subtype)
  );
}

async function* serializeSparqlXml(
  result: RDF.QueryBindings<unknown> | RDF.QueryBoolean,
): AsyncGenerator<string> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n';
  yield '<sparql xmlns="http://www.w3.org/2005/sparql-results#" xmlns:its="http://www.w3.org/2005/11/its" its:version="2.0">';

  if (result.resultType === 'boolean') {
    yield '<head></head><boolean>';
    yield String(await result.execute());
    yield '</boolean></sparql>';
    return;
  }

  const metadata = await result.metadata();
  yield '<head>';
  for (const variable of metadata.variables) {
    yield `<variable name="${escapeXml(variable.value)}"/>`;
  }
  yield '</head><results>';

  const bindingsStream = await result.execute();
  for await (const bindings of bindingsStream as unknown as AsyncIterable<RDF.Bindings>) {
    yield '<result>';
    for (const [variable, term] of bindings) {
      yield `<binding name="${escapeXml(variable.value)}">${termToSparqlXml(term)}</binding>`;
    }
    yield '</result>';
  }
  yield '</results></sparql>';
}

function termToSparqlXml(term: RDF.Term): string {
  switch (term.termType) {
    case 'NamedNode':
      return `<uri>${escapeXml(term.value)}</uri>`;
    case 'BlankNode':
      return `<bnode>${escapeXml(term.value)}</bnode>`;
    case 'Literal': {
      const direction =
        'direction' in term && typeof term.direction === 'string'
          ? term.direction
          : '';
      const attributes = term.language
        ? ` xml:lang="${escapeXml(term.language)}"${direction ? ` its:dir="${escapeXml(direction)}"` : ''}`
        : term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string'
          ? ` datatype="${escapeXml(term.datatype.value)}"`
          : '';
      return `<literal${attributes}>${escapeXml(term.value)}</literal>`;
    }
    case 'Quad':
      return `<triple><subject>${termToSparqlXml(term.subject)}</subject><predicate>${termToSparqlXml(term.predicate)}</predicate><object>${termToSparqlXml(term.object)}</object></triple>`;
    default:
      throw new Error(
        `RDF term type ${term.termType} cannot appear in a SPARQL XML binding`,
      );
  }
}

function escapeXml(value: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  };
  return value.replace(
    /[&<>"']/gu,
    (character) => escapes[character] as string,
  );
}

function toWebStream(
  data: AsyncIterable<unknown>,
  limits: { deadline: number; maxBytes: number; signal: AbortSignal },
): ReadableStream<Uint8Array> {
  const iterator = data[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await withDeadline(
          iterator.next(),
          limits.deadline,
          limits.signal,
        );
        if (next.done) {
          controller.close();
          return;
        }
        const chunk =
          typeof next.value === 'string'
            ? encoder.encode(next.value)
            : next.value instanceof Uint8Array
              ? next.value
              : encoder.encode(String(next.value));
        bytes += chunk.byteLength;
        if (bytes > limits.maxBytes) {
          await iterator.return?.();
          throw new HttpError(
            413,
            'SPARQL result exceeds the configured size limit',
          );
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return Promise.reject(new HttpError(504, 'SPARQL query timed out'));
  }
  if (signal?.aborted) {
    return Promise.reject(new HttpError(499, 'SPARQL request was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const settle = (operation: () => void) => {
      clearTimeout(timer);
      cleanup();
      operation();
    };
    const onAbort = () =>
      settle(() => reject(new HttpError(499, 'SPARQL request was cancelled')));
    const timer = setTimeout(
      () => settle(() => reject(new HttpError(504, 'SPARQL query timed out'))),
      remaining,
    );
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
    if (signal?.aborted) {
      onAbort();
    }
  });
}

function assertActiveDeadline(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HttpError(499, 'SPARQL request was cancelled');
  }
  if (performance.now() >= deadline) {
    throw new HttpError(504, 'SPARQL query timed out');
  }
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error) {
    if (/parse|syntax|query type/i.test(error.message)) {
      return new HttpError(400, error.message);
    }
    return new HttpError(500, error.message);
  }
  return new HttpError(500, 'Unknown SPARQL query execution error');
}

function observe(
  options: SparqlHandlerOptions,
  started: number,
  queryBytes: number,
  status: number,
  resultType?: string,
  mediaType?: string,
  error?: string,
): void {
  options.observe?.({
    durationMs: performance.now() - started,
    queryBytes,
    status,
    ...(resultType ? { resultType } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(error ? { error } : {}),
  });
}
