import { DataFactory } from 'rdf-data-factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowServiceUrls, createSparqlExecutor } from '../src/sparql.js';
import { D1QuadSource, insertQuads } from '../src/d1-source.js';
import { initializeStore } from '../src/schema.js';
import { MemoryD1 } from './memory-d1.js';

const factory = new DataFactory();
const iri = (value: string) =>
  factory.namedNode(`https://example.test/${value}`);
const bodyText = (body?: ReadableStream<Uint8Array>) =>
  body ? new Response(body).text() : Promise.resolve('');

describe('transport-neutral SPARQL executor', () => {
  let db: MemoryD1;

  beforeEach(async () => {
    db = new MemoryD1();
    await initializeStore(db);
    await insertQuads(db, [
      factory.quad(iri('alice'), iri('name'), factory.literal('Alice')),
    ]);
  });
  afterEach(() => db.close());

  it.each([
    'application/sparql-results+json',
    'application/sparql-results+xml',
    'text/csv',
    'text/tab-separated-values',
  ])('executes and serializes bindings as %s', async (accept) => {
    const result = await createSparqlExecutor({ db })({
      operation: 'query',
      text: 'SELECT ?name WHERE { ?s <https://example.test/name> ?name }',
      accept,
    });
    expect(result.status).toBe(200);
    expect(result.mediaType).toBe(accept);
    expect(await bodyText(result.body)).toContain('Alice');
  });

  it('serializes RDF graphs', async () => {
    const result = await createSparqlExecutor({ db })({
      operation: 'query',
      text: 'CONSTRUCT WHERE { ?s ?p ?o }',
      accept: 'application/n-triples',
    });
    expect(await bodyText(result.body)).toContain('example.test/alice');
  });

  it('rejects operation confusion and updates by default', async () => {
    const execute = createSparqlExecutor({ db });
    const update = 'INSERT DATA { <x:a> <x:b> <x:c> }';
    expect((await execute({ operation: 'query', text: update })).status).toBe(
      400,
    );
    expect((await execute({ operation: 'update', text: update })).status).toBe(
      403,
    );
  });

  it('executes explicitly enabled updates', async () => {
    const result = await createSparqlExecutor({
      db,
      policy: { readOnly: false },
    })({
      operation: 'update',
      text: 'INSERT DATA { <https://example.test/b> <https://example.test/p> "v" }',
    });
    expect(result).toEqual({ status: 204 });
  });

  it('enforces byte, algebra, result, and cancellation limits', async () => {
    const tooLarge = await createSparqlExecutor({
      db,
      policy: { maxQueryBytes: 2 },
    })({ operation: 'query', text: 'ASK {}' });
    expect(tooLarge.status).toBe(413);
    const tooComplex = await createSparqlExecutor({
      db,
      policy: { maxAlgebraOperations: 0 },
    })({ operation: 'query', text: 'ASK {}' });
    expect(tooComplex.status).toBe(422);
    const bounded = await createSparqlExecutor({
      db,
      policy: { maxResultBytes: 1 },
    })({ operation: 'query', text: 'ASK {}' });
    await expect(bodyText(bounded.body)).rejects.toThrow(/size limit/u);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await createSparqlExecutor({ db })({
      operation: 'query',
      text: 'ASK {}',
      signal: controller.signal,
    });
    expect(cancelled.status).toBe(499);
  });

  it('rejects LOAD, dynamic SERVICE, credentials, and disabled federation', async () => {
    const load = await createSparqlExecutor({
      db,
      policy: { readOnly: false },
    })({
      operation: 'update',
      text: 'LOAD <https://example.test/data>',
    });
    expect(load.status).toBe(403);
    const federated = createSparqlExecutor({
      db,
      policy: { authorizeService: () => true },
    });
    expect(
      (
        await federated({
          operation: 'query',
          text: 'SELECT * WHERE { SERVICE ?target { ?s ?p ?o } }',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await federated({
          operation: 'query',
          text: 'SELECT * WHERE { SERVICE <https://user:pass@example.test/sparql> { ?s ?p ?o } }',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await createSparqlExecutor({ db })({
          operation: 'query',
          text: 'SELECT * WHERE { SERVICE <https://example.test/sparql> { ?s ?p ?o } }',
        })
      ).status,
    ).toBe(403);
  });

  it('uses exact SERVICE allowlists and rejects redirects', async () => {
    const fetchService = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: '/private' } }),
    );
    const result = await createSparqlExecutor({
      db,
      policy: {
        authorizeService: (url) =>
          url.origin === 'https://example.test' && url.pathname === '/sparql',
        fetchService,
      },
    })({
      operation: 'query',
      text: 'SELECT * WHERE { SERVICE <https://example.test/sparql> { ?s ?p ?o } }',
    });
    expect(result.status).toBe(200);
    await expect(bodyText(result.body)).rejects.toThrow(/redirect/u);
    expect(fetchService).toHaveBeenCalled();
  });

  it('emits transport-neutral observations', async () => {
    const observe = vi.fn();
    await createSparqlExecutor({ db, observe })({
      operation: 'query',
      text: 'ASK {}',
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, queryBytes: 6 }),
    );
  });

  it('supports explicit source factories, pagination observations, and default media', async () => {
    const sourceFactory = vi.fn(
      (factoryDb, options) => new D1QuadSource(factoryDb, options),
    );
    const observeD1 = vi.fn();
    const result = await createSparqlExecutor({
      db,
      sourceFactory,
      sourcePageSize: 1,
      observeD1,
    })({ operation: 'query', text: 'ASK { ?s ?p ?o }' });
    expect(result.mediaType).toBe('application/sparql-results+json');
    expect(sourceFactory).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ readOnly: true, pageSize: 1 }),
    );
    await bodyText(result.body);
    expect(observeD1).toHaveBeenCalled();
  });

  it('handles accept ranges, unacceptable media, depth, and query/update mismatch', async () => {
    const execute = createSparqlExecutor({ db });
    const ranged = await execute({
      operation: 'query',
      text: 'ASK {}',
      accept: 'text/*;q=0.2, application/sparql-results+json;q=0.8',
    });
    expect(ranged.mediaType).toBe('application/sparql-results+json');
    const booleanXml = await execute({
      operation: 'query',
      text: 'ASK {}',
      accept: 'application/sparql-results+xml',
    });
    expect(await bodyText(booleanXml.body)).toContain(
      '<boolean>true</boolean>',
    );
    const wildcard = await execute({
      operation: 'query',
      text: 'ASK {}',
      accept: '*/*;q=bogus, application/sparql-results+json;q=0.4',
    });
    expect(wildcard.mediaType).toBe('application/sparql-results+json');
    expect(
      (
        await execute({
          operation: 'query',
          text: 'ASK {}',
          accept: 'image/png',
        })
      ).status,
    ).toBe(406);
    expect(
      (
        await execute({
          operation: 'update',
          text: 'SELECT * WHERE { ?s ?p ?o }',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createSparqlExecutor({
          db,
          policy: { maxAlgebraDepth: 1 },
        })({ operation: 'query', text: 'ASK {}' })
      ).status,
    ).toBe(422);
  });

  it('provides exact URL allowlists and immediate timeout errors', async () => {
    const authorize = allowServiceUrls([
      'https://example.test/sparql',
      new URL('https://example.test/other'),
    ]);
    expect(await authorize(new URL('https://example.test/sparql'))).toBe(true);
    expect(
      await authorize(new URL('https://example.test/sparql?query=x')),
    ).toBe(false);
    const timedOut = await createSparqlExecutor({
      db,
      policy: { timeoutMs: 0 },
    })({ operation: 'query', text: 'ASK {}' });
    expect(timedOut.status).toBe(504);
  });
});
