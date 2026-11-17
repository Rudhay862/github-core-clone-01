import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const requestId = nextRequestId();
  if (status === 204) {
    res.writeHead(status, {
      'x-github-request-id': requestId,
      'content-length': '0',
      ...(extraHeaders ?? {}),
    });
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  buf: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const requestId = nextRequestId();
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(buf.length),
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  });
  res.end(buf);
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

export function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
