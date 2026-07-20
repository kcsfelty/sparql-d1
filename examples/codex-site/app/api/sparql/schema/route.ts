import { env } from 'cloudflare:workers';
import { inspectStoreSchema } from '@gnolith/diamond';

interface SiteEnvironment {
  DB: D1Database;
  SPARQL_ADMIN_TOKEN?: string;
}

const siteEnv = env as unknown as SiteEnvironment;

export async function GET(request: Request): Promise<Response> {
  if (!siteEnv.SPARQL_ADMIN_TOKEN) {
    return new Response('SPARQL schema endpoint is not configured', {
      status: 503,
    });
  }
  if (
    request.headers.get('authorization') !==
    `Bearer ${siteEnv.SPARQL_ADMIN_TOKEN}`
  ) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const inspection = await inspectStoreSchema(siteEnv.DB);
  return Response.json(inspection, {
    status: inspection.valid ? 200 : 500,
    headers: { 'cache-control': 'no-store' },
  });
}
