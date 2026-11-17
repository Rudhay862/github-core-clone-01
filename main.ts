// main.ts — the entry lifecycle: bind, register with the env, wait for done.
//
//   1. MAKEFUN_ENV_URL names the env origin. Without it there is nothing to
//      register with, so the process exits 1 at once.
//   2. createApp() from app.ts, then listen(0): the kernel picks a free
//      port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N} until the env accepts it:
//      200 is accepted, 409 means another entry registered first (keep
//      waiting anyway), 400/405 are contract errors and end the program.
//      Anything else is retried with exponential backoff, 250 ms → 2,000 ms,
//      each attempt abandoned after 30 s.
//   4. Poll GET $MAKEFUN_ENV_URL/done with the same backoff until the body
//      is {"done": true}, then close the server and exit 0.
//
// This file imports its own server and nothing else.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Backoff starts here and doubles to the cap below. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait after `failures` failed attempts: doubling, capped. */
function backoffMs(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return doubled > BACKOFF_CAP_MS ? BACKOFF_CAP_MS : doubled;
}

/**
 * POST the bound port until the env takes it. 200 and 409 both mean "move
 * on"; 400 and 405 mean the request itself is wrong and stop the program;
 * anything else (including the env not answering yet) is retried.
 */
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let fatal = '';
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) fatal = `register refused: HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    if (fatal !== '') throw new Error(fatal);
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done.
    }
    await sleep(backoffMs(failures));
    failures += 1;
  }
}

/** Bind, register, wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await register(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
