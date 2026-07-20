import { DataFactory } from 'rdf-data-factory';
import type { QueryEngine } from '@comunica/query-sparql/lib/QueryEngine.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowServiceUrls, createSparqlHandler } from '../src/endpoint.js';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import { initializeStore } from '../src/schema.js';
import { MemoryD1 } from './memory-d1.js';

const factory = new DataFactory();
const ex = (value: string) =>
  factory.namedNode(`https://example.test/${value}`);

describe('SPARQL HTTP handler', () => {
  let db: MemoryD1;
  let handle: ReturnType<typeof createSparqlHandler>;

  beforeEach(async () => {
    db = new MemoryD1();
    await initializeStore(db);
    await insertQuads(db, [
      factory.quad(ex('alice'), ex('name'), factory.literal('Alice')),
    ]);
    handle = createSparqlHandler({ db, exposeErrors: true });
  });

  afterEach(() => db.close());

  it('executes GET queries and serializes SPARQL Results JSON', async () => {
    const query = encodeURIComponent(
      'SELECT ?name WHERE { ?s <https://example.test/name> ?name }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/sparql-results+json',
    );
    const body = (await response.json()) as {
      results: { bindings: Array<{ name: { value: string } }> };
    };
    expect(body.results.bindings[0]?.name.value).toBe('Alice');
  });

  it('supports application/sparql-query POST requests', async () => {
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-query' },
        body: 'ASK { <https://example.test/alice> ?p ?o }',
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ boolean: true });
  });

  it('negotiates RDF graph output', async () => {
    const query = encodeURIComponent('CONSTRUCT WHERE { ?s ?p ?o }');
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: { accept: 'application/n-triples' },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/n-triples',
    );
    expect(await response.text()).toContain('https://example.test/alice');
  });

  it.each([
    'application/sparql-results+json',
    'application/sparql-results+xml',
    'text/csv',
    'text/tab-separated-values',
  ])('serializes bindings as %s', async (mediaType) => {
    const query = encodeURIComponent(
      'SELECT ?name WHERE { ?s <https://example.test/name> ?name }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: { accept: mediaType },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain(mediaType);
    expect(await response.text()).toContain('Alice');
  });

  it('serializes ASK results as SPARQL Results XML', async () => {
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D', {
        headers: { accept: 'application/sparql-results+xml' },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'application/sparql-results+xml',
    );
    const body = await response.text();
    expect(body).toContain('<head></head><boolean>true</boolean>');
    expect(body).toContain('</sparql>');
  });

  it('escapes RDF values in SPARQL Results XML', async () => {
    await insertQuads(db, [
      factory.quad(ex('escaped'), ex('value'), factory.literal('<&>"')),
    ]);
    const query = encodeURIComponent(
      'SELECT ?value WHERE { <https://example.test/escaped> <https://example.test/value> ?value }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: { accept: 'application/sparql-results+xml' },
      }),
    );
    expect(await response.text()).toContain('&lt;&amp;&gt;&quot;');
  });

  it('preserves every RDF binding shape in SPARQL Results XML', async () => {
    const subject = ex('xml-terms');
    await insertQuads(db, [
      factory.quad(subject, ex('iri'), ex('object')),
      factory.quad(subject, ex('blank'), factory.blankNode('xml-blank')),
      factory.quad(subject, ex('language'), factory.literal('bonjour', 'fr')),
      factory.quad(
        subject,
        ex('typed'),
        factory.literal(
          '42',
          factory.namedNode('http://www.w3.org/2001/XMLSchema#integer'),
        ),
      ),
      factory.quad(
        subject,
        ex('quoted'),
        factory.quad(
          ex('quoted-subject'),
          ex('quoted-predicate'),
          factory.literal('quoted'),
        ),
      ),
    ]);
    const query =
      encodeURIComponent(`SELECT ?iri ?blank ?language ?typed ?quoted WHERE {
      <https://example.test/xml-terms> <https://example.test/iri> ?iri;
        <https://example.test/blank> ?blank;
        <https://example.test/language> ?language;
        <https://example.test/typed> ?typed;
        <https://example.test/quoted> ?quoted.
    }`);
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: { accept: 'application/sparql-results+xml' },
      }),
    );
    const xml = await response.text();
    expect(response.status, xml).toBe(200);
    expect(xml).toContain('<uri>https://example.test/object</uri>');
    expect(xml).toMatch(/<bnode>[^<]*xml-blank<\/bnode>/u);
    expect(xml).toContain('<literal xml:lang="fr">bonjour</literal>');
    expect(xml).toContain(
      '<literal datatype="http://www.w3.org/2001/XMLSchema#integer">42</literal>',
    );
    expect(xml).toContain('<triple><subject><uri>');
  });

  it.each([
    'text/turtle',
    'application/n-triples',
    'application/n-quads',
    'application/trig',
    'application/ld+json',
  ])('serializes RDF graphs as %s', async (mediaType) => {
    const query = encodeURIComponent('CONSTRUCT WHERE { ?s ?p ?o }');
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: { accept: mediaType },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('content-type')).toContain(mediaType);
    expect(await response.text()).toContain('https://example.test/alice');
  });

  it('honors media ranges, quality weights, and exact exclusions', async () => {
    const query = encodeURIComponent(
      'SELECT ?name WHERE { ?s <https://example.test/name> ?name }',
    );
    const weighted = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: {
          accept: 'text/*;q=0.9, application/sparql-results+json;q=0.5',
        },
      }),
    );
    expect(weighted.headers.get('content-type')).toContain('text/csv');

    const excluded = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`, {
        headers: {
          accept: 'application/*;q=0.8, application/sparql-results+json;q=0',
        },
      }),
    );
    expect(excluded.headers.get('content-type')).toContain(
      'application/sparql-results+xml',
    );
  });

  it('is read-only by default', async () => {
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: 'INSERT DATA { <x:s> <x:p> <x:o> }',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('executes atomic update streams only when explicitly enabled', async () => {
    handle = createSparqlHandler({ db, readOnly: false, exposeErrors: true });
    const update = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: 'INSERT DATA { <https://example.test/bob> <https://example.test/name> "Bob" }',
      }),
    );
    expect(update.status, await update.clone().text()).toBe(204);
    await expect(new D1QuadSource(db).countQuads(ex('bob'))).resolves.toBe(1);

    const query = encodeURIComponent(
      'ASK { <https://example.test/bob> <https://example.test/name> "Bob" }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    await expect(response.json()).resolves.toMatchObject({ boolean: true });
  });

  it('rejects remote LOAD even on a writable endpoint', async () => {
    const engine = {
      query: vi.fn(() => {
        throw new Error('LOAD must be rejected before engine execution');
      }),
    } as unknown as QueryEngine;
    handle = createSparqlHandler({
      db,
      engine,
      readOnly: false,
      exposeErrors: true,
    });
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: 'LOAD <https://untrusted.example/data.ttl>',
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('LOAD is disabled'),
    });
    expect(engine.query).not.toHaveBeenCalled();
  });

  it('rejects SERVICE clauses by default', async () => {
    const query = encodeURIComponent(
      'SELECT * WHERE { SERVICE <https://example.test/sparql> { ?s ?p ?o } }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    expect(response.status).toBe(403);
  });

  it('requires every static SERVICE target to pass an explicit policy', async () => {
    let inspected: URL | undefined;
    handle = createSparqlHandler({
      db,
      servicePolicy(serviceIri) {
        inspected = serviceIri;
        return false;
      },
    });
    const query = encodeURIComponent(
      'SELECT * WHERE { SERVICE <https://blocked.example/sparql> { ?s ?p ?o } }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    expect(response.status).toBe(403);
    expect(inspected?.href).toBe('https://blocked.example/sparql');
  });

  it('rejects dynamic SERVICE targets that cannot be authorized statically', async () => {
    const query = encodeURIComponent(
      'SELECT * WHERE { SERVICE ?endpoint { ?s ?p ?o } }',
    );
    handle = createSparqlHandler({ db, servicePolicy: () => true });
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    expect(response.status).toBe(403);
  });

  it('builds exact canonical SERVICE URL allowlists', async () => {
    const policy = allowServiceUrls(['https://allowed.example/sparql']);
    const request = new Request('https://site.test/api/sparql');
    expect(
      await policy(new URL('https://allowed.example/sparql'), request),
    ).toBe(true);
    expect(
      await policy(new URL('https://allowed.example/sparql/extra'), request),
    ).toBe(false);
    expect(
      await policy(new URL('https://allowed.example.evil/sparql'), request),
    ).toBe(false);
  });

  it('reauthorizes outbound SERVICE fetches and rejects redirects', async () => {
    const transport = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/internal' },
        }),
    );
    const engine = {
      query: async (
        _query: string,
        context: { fetch?: typeof globalThis.fetch },
      ) => {
        await context.fetch?.('https://allowed.example/sparql');
        throw new Error('redirect should have been rejected');
      },
    } as unknown as QueryEngine;
    handle = createSparqlHandler({
      db,
      engine,
      servicePolicy: allowServiceUrls(['https://allowed.example/sparql']),
      serviceFetch: transport,
    });
    const query = encodeURIComponent(
      'SELECT * WHERE { SERVICE <https://allowed.example/sparql> { ?s ?p ?o } }',
    );
    const response = await handle(
      new Request(`https://site.test/api/sparql?query=${query}`),
    );
    expect(response.status).toBe(403);
    expect(transport).toHaveBeenCalledWith(
      'https://allowed.example/sparql',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('enforces authentication hooks', async () => {
    handle = createSparqlHandler({ db, authenticate: () => false });
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(response.status).toBe(401);
  });

  it('allows authentication hooks to return a complete response', async () => {
    handle = createSparqlHandler({
      db,
      authenticate: () => new Response('identity unavailable', { status: 503 }),
    });
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('identity unavailable');
  });

  it('enforces host-provided rate limits before query parsing', async () => {
    let authenticated = false;
    handle = createSparqlHandler({
      db,
      rateLimit: () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '60' },
        }),
      authenticate: () => {
        authenticated = true;
        return true;
      },
    });
    const response = await handle(
      new Request('https://site.test/api/sparql?query=not-even-sparql'),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(authenticated).toBe(false);
  });

  it('enforces query-size limits', async () => {
    handle = createSparqlHandler({ db, maxQueryBytes: 5 });
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(response.status).toBe(413);
  });

  it('rejects oversized POST bodies before or while reading them', async () => {
    handle = createSparqlHandler({ db, maxQueryBytes: 12 });
    const declared = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: {
          'content-type': 'application/sparql-query',
          'content-length': '100',
        },
        body: 'ASK {}',
      }),
    );
    expect(declared.status).toBe(413);

    let cancelled = false;
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ASK { '));
        controller.enqueue(new TextEncoder().encode('?s ?p ?o }'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunked = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-query' },
        body: chunkedBody,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(chunked.status).toBe(413);
    expect(cancelled).toBe(true);

    const incorrectlySized = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: {
          'content-type': 'application/sparql-query',
          'content-length': '1',
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ASK { ?s ?p ?o }'));
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(incorrectlySized.status).toBe(413);

    const writable = createSparqlHandler({
      db,
      readOnly: false,
      maxQueryBytes: 12,
    });
    const update = await writable(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: 'INSERT DATA { <x:s> <x:p> <x:o> }',
      }),
    );
    expect(update.status).toBe(413);

    const form = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query: 'ASK {}', ignored: 'x'.repeat(40) }),
      }),
    );
    expect(form.status).toBe(413);
  });

  it('rejects unsupported result media types', async () => {
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D', {
        headers: { accept: 'image/png' },
      }),
    );
    expect(response.status).toBe(406);
  });

  it('supports form-encoded queries and rejects form-encoded updates', async () => {
    const queryResponse = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query: 'ASK {}' }),
      }),
    );
    expect(queryResponse.status).toBe(200);

    const updateResponse = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          update: 'INSERT DATA { <x:s> <x:p> <x:o> }',
        }),
      }),
    );
    expect(updateResponse.status).toBe(403);
  });

  it.each([
    [new Request('https://site.test/api/sparql'), 400],
    [new Request('https://site.test/api/sparql', { method: 'PUT' }), 405],
    [
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'ASK {}',
      }),
      415,
    ],
  ] as const)(
    'returns protocol errors for malformed requests %#',
    async (request, status) => {
      await expect(handle(request)).resolves.toMatchObject({ status });
    },
  );

  it('rejects update query parameters because updates require POST', async () => {
    const update = encodeURIComponent('INSERT DATA { <x:s> <x:p> <x:o> }');
    const response = await handle(
      new Request(`https://site.test/api/sparql?update=${update}`),
    );
    expect(response.status).toBe(405);
  });

  it('rejects updates disguised with a query media type', async () => {
    handle = createSparqlHandler({ db, readOnly: false });
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-query' },
        body: 'INSERT DATA { <https://example.test/disguised> <x:p> <x:o> }',
      }),
    );
    expect(response.status).toBe(400);
    await expect(
      new D1QuadSource(db).countQuads(ex('disguised')),
    ).resolves.toBe(0);
  });

  it('rejects queries disguised with an update media type', async () => {
    handle = createSparqlHandler({ db, readOnly: false });
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: 'ASK {}',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects ambiguous form operations', async () => {
    handle = createSparqlHandler({ db, readOnly: false });
    const response = await handle(
      new Request('https://site.test/api/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query: 'ASK {}', update: 'CLEAR ALL' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('enforces algebra operation and depth limits', async () => {
    const request = () =>
      new Request(
        'https://site.test/api/sparql?query=SELECT%20*%20WHERE%20%7B%3Fs%20%3Fp%20%3Fo%7D',
      );
    handle = createSparqlHandler({ db, maxAlgebraOperations: 0 });
    expect((await handle(request())).status).toBe(422);
    handle = createSparqlHandler({ db, maxAlgebraDepth: 1 });
    expect((await handle(request())).status).toBe(422);
  });

  it('classifies invalid SPARQL as a client error', async () => {
    const response = await handle(
      new Request('https://site.test/api/sparql?query=SELECT%20%7B'),
    );
    expect(response.status).toBe(400);
  });

  it('terminates serialized results at the configured byte limit', async () => {
    handle = createSparqlHandler({ db, maxResultBytes: 1 });
    const response = await handle(
      new Request(
        'https://site.test/api/sparql?query=SELECT%20*%20WHERE%20%7B%3Fs%20%3Fp%20%3Fo%7D',
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow('configured size limit');
  });

  it('times out stalled engine work and redacts unexpected errors', async () => {
    const stalled = {
      query: () => new Promise(() => undefined),
    } as unknown as QueryEngine;
    handle = createSparqlHandler({ db, engine: stalled, timeoutMs: 1 });
    expect(
      (
        await handle(
          new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
        )
      ).status,
    ).toBe(504);

    const broken = {
      query: async () => {
        throw new Error('sensitive database detail');
      },
    } as unknown as QueryEngine;
    handle = createSparqlHandler({ db, engine: broken });
    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'SPARQL query execution failed',
    });
  });

  it('uses one timeout budget for engine acquisition and query work', async () => {
    let queryStarted = false;
    const delayedEngine = new Promise<QueryEngine>((resolve) => {
      setTimeout(
        () =>
          resolve({
            query: () => {
              queryStarted = true;
              return new Promise((queryResolve) =>
                setTimeout(
                  () =>
                    queryResolve({
                      resultType: 'void',
                      execute: async () => undefined,
                    }),
                  40,
                ),
              );
            },
          } as unknown as QueryEngine),
        20,
      );
    });
    handle = createSparqlHandler({
      db,
      engine: delayedEngine,
      timeoutMs: 50,
    });

    const response = await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(queryStarted).toBe(true);
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: 'SPARQL query execution failed',
    });
  });

  it('terminates work when the client request is cancelled', async () => {
    const stalled = {
      query: () => new Promise(() => undefined),
    } as unknown as QueryEngine;
    const controller = new AbortController();
    handle = createSparqlHandler({ db, engine: stalled });
    const responsePromise = handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D', {
        signal: controller.signal,
      }),
    );
    controller.abort();
    await expect(responsePromise).resolves.toMatchObject({ status: 499 });
  });

  it('reports request observations', async () => {
    const observations: Array<{ status: number }> = [];
    handle = createSparqlHandler({
      db,
      observe: (observation) => observations.push(observation),
    });
    await handle(
      new Request('https://site.test/api/sparql?query=ASK%20%7B%7D'),
    );
    expect(observations).toMatchObject([{ status: 200 }]);
  });

  it('accepts a source factory as the optimization boundary', async () => {
    let factoryCalls = 0;
    handle = createSparqlHandler({
      db,
      sourceFactory(factoryDb, options) {
        factoryCalls += 1;
        expect(factoryDb).toBe(db);
        expect(options.readOnly).toBe(true);
        return new D1QuadSource(
          factoryDb,
          options.observe ? { observe: options.observe } : {},
        );
      },
    });
    const response = await handle(
      new Request(
        'https://site.test/api/sparql?query=ASK%20%7B%3Fs%20%3Fp%20%3Fo%7D',
      ),
    );
    expect(response.status).toBe(200);
    expect(factoryCalls).toBe(1);
  });

  it('enables bounded source pagination through handler options', async () => {
    const pages: number[] = [];
    await insertQuads(db, [
      factory.quad(ex('bob'), ex('name'), factory.literal('Bob')),
    ]);
    handle = createSparqlHandler({
      db,
      sourcePageSize: 1,
      observeD1(observation) {
        if (observation.metadata?.readMode === 'paginated') {
          pages.push(Number(observation.metadata.page));
        }
      },
    });
    const response = await handle(
      new Request(
        'https://site.test/api/sparql?query=SELECT%20*%20WHERE%20%7B%3Fs%20%3Fp%20%3Fo%7D',
      ),
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(pages.length).toBeGreaterThan(1);
  });
});
