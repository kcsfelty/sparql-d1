import { QueryEngine } from '@comunica/query-sparql';
import type * as RDF from '@rdfjs/types';
import { D1QuadSource, D1QuadStore } from './d1-source.js';
import type { QueryObservation } from './d1-source.js';
import type { D1DatabaseLike } from './d1-types.js';

const QUERY_RESULT_MEDIA_TYPES = new Set([
  'application/sparql-results+json',
  'application/sparql-results+xml',
  'text/csv',
  'text/tab-separated-values',
]);

const RDF_MEDIA_TYPES = new Set([
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'application/ld+json',
]);

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

export interface SparqlHandlerOptions {
  db: D1DatabaseLike;
  engine?: QueryEngine;
  authenticate?: (
    request: Request,
  ) => boolean | Response | Promise<boolean | Response>;
  readOnly?: boolean;
  allowService?: boolean;
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
  const engine = options.engine ?? new QueryEngine();
  const readOnly = options.readOnly ?? true;
  const sourceOptions = options.observeD1 ? { observe: options.observeD1 } : {};
  const source = readOnly
    ? new D1QuadSource(options.db, sourceOptions)
    : new D1QuadStore(options.db, sourceOptions);
  const allowService = options.allowService ?? false;
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
      const authResult = await options.authenticate?.(request);
      if (authResult instanceof Response) {
        observe(options, started, queryBytes, authResult.status);
        return authResult;
      }
      if (authResult === false) {
        throw new HttpError(401, 'Unauthorized');
      }

      const query = await extractQuery(request, readOnly);
      queryBytes = new TextEncoder().encode(query).byteLength;
      if (queryBytes > limits.maxQueryBytes) {
        throw new HttpError(
          413,
          'SPARQL query exceeds the configured size limit',
        );
      }

      const context = { sources: [source], readOnly };
      const explanation = await withTimeout(
        engine.explain(query, { ...context }, 'parsed'),
        limits.timeoutMs,
      );
      const analysis = analyzeAlgebra(explanation.data as unknown);

      if (analysis.operations > limits.maxAlgebraOperations) {
        throw new HttpError(422, 'SPARQL query contains too many operations');
      }
      if (analysis.depth > limits.maxAlgebraDepth) {
        throw new HttpError(422, 'SPARQL query is nested too deeply');
      }
      if (!allowService && analysis.types.has('service')) {
        throw new HttpError(403, 'Federated SERVICE clauses are disabled');
      }
      if (
        readOnly &&
        [...analysis.types].some((type) => UPDATE_OPERATIONS.has(type))
      ) {
        throw new HttpError(403, 'SPARQL Update is disabled');
      }

      const deadline = performance.now() + limits.timeoutMs;
      const result = await withDeadline(engine.query(query, context), deadline);
      resultType = result.resultType;

      if (result.resultType === 'void') {
        await withDeadline(result.execute(), deadline);
        observe(options, started, queryBytes, 204, resultType);
        return new Response(null, { status: 204 });
      }

      const available = await engine.getResultMediaTypes(context);
      mediaType = negotiateMediaType(
        request.headers.get('accept'),
        result.resultType,
        new Set(Object.keys(available)),
      );
      const serialized = await withDeadline(
        engine.resultToString(result as RDF.Query<unknown>, mediaType, context),
        deadline,
      );
      const body = toWebStream(serialized.data, {
        deadline,
        maxBytes: limits.maxResultBytes,
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

async function extractQuery(
  request: Request,
  readOnly: boolean,
): Promise<string> {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const update = url.searchParams.get('update');
    if (update !== null && readOnly) {
      throw new HttpError(403, 'SPARQL Update is disabled');
    }
    const query = url.searchParams.get('query') ?? update;
    if (!query) {
      throw new HttpError(400, 'Missing SPARQL query');
    }
    return query;
  }

  if (request.method !== 'POST') {
    throw new HttpError(405, 'Only GET and POST are supported');
  }

  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim();
  if (contentType === 'application/sparql-query') {
    return request.text();
  }
  if (contentType === 'application/sparql-update') {
    if (readOnly) {
      throw new HttpError(403, 'SPARQL Update is disabled');
    }
    return request.text();
  }
  if (contentType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(await request.text());
    const update = form.get('update');
    if (update !== null && readOnly) {
      throw new HttpError(403, 'SPARQL Update is disabled');
    }
    const query = form.get('query') ?? update;
    if (!query) {
      throw new HttpError(400, 'Missing SPARQL query');
    }
    return query;
  }
  throw new HttpError(415, 'Unsupported SPARQL request content type');
}

function analyzeAlgebra(value: unknown): {
  depth: number;
  operations: number;
  types: Set<string>;
} {
  const types = new Set<string>();
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
    }
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };

  visit(value, 1);
  return { depth: maximumDepth, operations, types };
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

  if (!requested.length || requested.some((item) => item.mediaType === '*/*')) {
    if (available.has(fallback)) {
      return fallback;
    }
  }

  for (const item of requested) {
    if (
      item.quality > 0 &&
      allowed.has(item.mediaType) &&
      available.has(item.mediaType)
    ) {
      return item.mediaType;
    }
  }
  throw new HttpError(406, 'No acceptable SPARQL result format is available');
}

function parseAccept(
  value: string | null,
): Array<{ mediaType: string; quality: number }> {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => {
      const [mediaType = '', ...parameters] = item.trim().split(';');
      const q = parameters.find((parameter) =>
        parameter.trim().startsWith('q='),
      );
      return {
        mediaType: mediaType.trim().toLowerCase(),
        quality: q ? Number(q.trim().slice(2)) : 1,
      };
    })
    .filter((item) => item.mediaType)
    .sort((left, right) => right.quality - left.quality);
}

function toWebStream(
  data: NodeJS.ReadableStream,
  limits: { deadline: number; maxBytes: number },
): ReadableStream<Uint8Array> {
  const iterable = data as NodeJS.ReadableStream & AsyncIterable<unknown>;
  const iterator = iterable[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await withDeadline(iterator.next(), limits.deadline);
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return withDeadline(promise, performance.now() + timeoutMs);
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    return Promise.reject(new HttpError(504, 'SPARQL query timed out'));
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(
        () => reject(new HttpError(504, 'SPARQL query timed out')),
        remaining,
      );
      timer.unref?.();
    }),
  ]);
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
