import { env } from 'cloudflare:workers';
import { createSparqlHandler } from '@gnolith/diamond/endpoint';

interface SiteEnvironment {
  DB: D1Database;
  SPARQL_TOKEN?: string;
}

const siteEnv = env as unknown as SiteEnvironment;
const handle = createSparqlHandler({
  db: siteEnv.DB,
  authenticate(request) {
    if (!siteEnv.SPARQL_TOKEN) {
      return new Response('SPARQL endpoint is not configured', { status: 503 });
    }
    return (
      request.headers.get('authorization') === `Bearer ${siteEnv.SPARQL_TOKEN}`
    );
  },
  readOnly: true,
});

export const GET = handle;
export const POST = handle;
