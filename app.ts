// app.ts — the HTTP server: one store, created once, and the route table.
//
//   GET /healthz            → 200 {"ok": true}, no auth (the env boot probe)
//   /api/v3*                → REST v3 (rest.ts)
//   POST /api/graphql       → GraphQL (graphql.ts)
//   POST /mcp               → MCP over Streamable HTTP (mcp.ts)
//   *​/.git/*               → git smart HTTP (git-http.ts)
//   everything else         → 404 {"message": "Not Found"}
//
// Auth lives inside each handler (the bearer token must equal
// process.env.MAKEFUN_SHOP_TOKEN); /healthz is the only exempt route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { sendJson } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitHttp } from './git-http.ts';

/** The path part of a request URL, or '/' when it does not parse. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Whether a path is a git smart-HTTP route: /{owner}/{repo}.git/... */
function isGitPath(path: string): boolean {
  const parts = path.split('/');
  return parts.length >= 3 && parts[2]!.endsWith('.git');
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (await handleRest(req, res, store)) return;
  }

  if (method === 'POST' && path === '/api/graphql') {
    if (await handleGraphql(req, res, store)) return;
  }

  if (method === 'POST' && path === '/mcp') {
    if (await handleMcp(req, res, store)) return;
  }

  if (isGitPath(path)) {
    if (await handleGitHttp(req, res, store)) return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/**
 * Build the server. It binds nothing until the caller listens; the entry
 * listens on an ephemeral port. The store is created once here and shared by
 * every handler, so REST, GraphQL, MCP and git all see the same objects.
 */
export function createApp(): Server {
  const store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; there is nothing left to answer.
          res.destroy();
        }
      }
    });
  });
}
