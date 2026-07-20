import { env } from 'cloudflare:workers';
import { createSparqlHandler } from '@gnolith/diamond/endpoint';

interface SiteEnvironment {
  DB: D1Database;
  SPARQL_ADMIN_TOKEN?: string;
}

const siteEnv = env as unknown as SiteEnvironment;
const handle = createSparqlHandler({
  db: siteEnv.DB,
  authenticate(request) {
    if (!siteEnv.SPARQL_ADMIN_TOKEN) {
      return new Response('SPARQL administration endpoint is not configured', {
        status: 503,
      });
    }
    return (
      request.headers.get('authorization') ===
      `Bearer ${siteEnv.SPARQL_ADMIN_TOKEN}`
    );
  },
  readOnly: false,
});

export const GET = handle;
export const POST = handle;
