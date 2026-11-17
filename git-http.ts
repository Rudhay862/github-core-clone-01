// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 + v0 fallback),
// receive-pack (v0). Implements the wire contract of SPEC section 5.
// Auth is bearer-token exact equality with MAKEFUN_SHOP_TOKEN; a missing
// repo (or a repo under another owner) is a 404 and the server stays up.
// Only node:http types are used. No wall clock, no randomness.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag, parseTree, ZERO_OID } from './git.ts';
import type { GitRepo } from './git.ts';
import {
  buildPackFromObjects,
  parsePack,
  pktDelim,
  pktFlush,
  pktLineStr,
  sideband,
} from './pack.ts';
import type { Store } from './store.ts';

const VIEWER_LOGIN = 'adaiversen';
const MAIN_REF = 'refs/heads/main';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function sendBuf(
  res: ServerResponse,
  status: number,
  buf: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  sendBuf(res, status, buf, 'application/json; charset=utf-8');
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function tokenValid(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  return token !== null && token === process.env.MAKEFUN_SHOP_TOKEN;
}

// ---------------------------------------------------------------------------
// pkt-line parsing
// ---------------------------------------------------------------------------

type PktKind = 'line' | 'flush' | 'delim' | 'end';

interface PktItem {
  kind: PktKind;
  data: Buffer;
}

/** Parse pkt-lines from `buf`. When `stopAtFlush` is set, parsing stops
 *  after the first flush and `consumed` points just past it (the rest of
 *  the buffer is raw payload, e.g. a packfile). Throws on malformed input. */
function parsePktLines(
  buf: Buffer,
  stopAtFlush: boolean,
): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const prefix = buf.toString('ascii', pos, pos + 4);
    if (prefix === '0000') {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      pos += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (prefix === '0001') {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (prefix === '0002') {
      items.push({ kind: 'end', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) {
      throw new Error('malformed pkt-line');
    }
    const len = parseInt(prefix, 16);
    if (len < 4) throw new Error('pkt-line length < 4');
    if (pos + len > buf.length) throw new Error('pkt-line truncated');
    items.push({ kind: 'line', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { items, consumed: pos };
}

function lineText(item: PktItem): string {
  const s = item.data.toString('utf8');
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/** Split a protocol line at the NUL that separates arguments from the
 *  capability list: returns [beforeNul, capsAfterNul]. */
function splitCaps(line: string): [string, string] {
  const idx = line.indexOf('\0');
  if (idx < 0) return [line, ''];
  return [line.slice(0, idx), line.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------

function sortedRefNames(git: GitRepo): string[] {
  return Array.from(git.refs.keys()).sort();
}

/** Peel a tag object (recursively) to the commit it points at. Returns the
 *  input oid unchanged when it is not a tag object. */
function peelToCommit(git: GitRepo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = git.getObject(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.body).object;
  }
  return cur;
}

function isTagObject(git: GitRepo, oid: string): boolean {
  const obj = git.getObject(oid);
  return !!obj && obj.type === 'tag';
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLineStr('version 2'),
    pktLineStr('ls-refs=unborn'),
    pktLineStr('fetch=shallow wait-for-done'),
    pktLineStr('object-format=sha1'),
    pktFlush(),
  ]);
}

/** v0 ref advertisement: service preamble, flush, ref lines (capabilities
 *  after a NUL on the first line), flush. */
function v0Advertisement(service: string, git: GitRepo, caps: string): Buffer {
  const parts: Buffer[] = [pktLineStr('# service=' + service), pktFlush()];
  const names = sortedRefNames(git);
  const mainTip = git.getRef(MAIN_REF);
  let capsPlaced = false;
  const line = (oid: string, ref: string, withCaps: boolean): Buffer => {
    const payload = withCaps ? oid + ' ' + ref + '\0' + caps : oid + ' ' + ref;
    return pktLineStr(payload);
  };
  if (names.length === 0) {
    parts.push(line(ZERO_OID, 'capabilities^{}', true));
  } else {
    if (mainTip !== undefined) {
      parts.push(line(mainTip, 'HEAD', true));
      capsPlaced = true;
    }
    for (const name of names) {
      const oid = git.getRef(name) as string;
      const withCaps = !capsPlaced;
      parts.push(line(oid, name, withCaps));
      if (withCaps) capsPlaced = true;
      if (isTagObject(git, oid)) {
        parts.push(pktLineStr(peelToCommit(git, oid) + ' ' + name + '^{}'));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch planning: which objects to send
// ---------------------------------------------------------------------------

/** Objects the client already holds: closure of the `have` oids, except
 *  that parents of commits listed in `shallowSet` (already-held shallow
 *  boundaries) are not traversed — the client does not hold them. */
function collectHeld(git: GitRepo, haves: string[], shallowSet: Set<string>): Set<string> {
  const held = new Set<string>();
  const stack: string[] = haves.slice();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (held.has(sha)) continue;
    const obj = git.getObject(sha);
    if (!obj) continue;
    held.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.body);
      stack.push(c.tree);
      if (!shallowSet.has(sha)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.body)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.body).object);
    }
  }
  return held;
}

interface WantClosure {
  included: Set<string>;
  generation: Map<string, number>; // commit oid -> distance from a want
}

/** Closure of the `want` oids. With `deepen`, only commits within that many
 *  generations of a want are included (generation 0 = the want itself);
 *  without it, the full closure is taken, except parents of commits in
 *  `shallowSet` are not traversed. Trees and blobs of included commits are
 *  always fully included. */
function collectWant(
  git: GitRepo,
  wants: string[],
  shallowSet: Set<string>,
  deepen: number | null,
): WantClosure {
  const included = new Set<string>();
  const generation = new Map<string, number>();

  const addTree = (treeSha: string): void => {
    const stack: string[] = [treeSha];
    while (stack.length > 0) {
      const t = stack.pop() as string;
      if (included.has(t)) continue;
      const o = git.getObject(t);
      if (!o) continue;
      included.add(t);
      if (o.type === 'tree') {
        for (const e of parseTree(o.body)) stack.push(e.sha);
      }
    }
  };

  const queue: [string, number][] = wants.map((w) => [w, 0] as [string, number]);
  while (queue.length > 0) {
    const [sha, gen] = queue.shift() as [string, number];
    if (included.has(sha)) continue;
    const obj = git.getObject(sha);
    if (!obj) continue;
    included.add(sha);
    if (obj.type === 'commit') {
      generation.set(sha, gen);
      const c = parseCommit(obj.body);
      addTree(c.tree);
      const cut = deepen === null && shallowSet.has(sha);
      if (!cut && (deepen === null || gen + 1 < deepen)) {
        for (const p of c.parents) queue.push([p, gen + 1]);
      }
    } else if (obj.type === 'tree') {
      addTree(sha);
    } else if (obj.type === 'tag') {
      queue.push([parseTag(obj.body).object, gen]);
    }
  }
  return { included, generation };
}

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  git: GitRepo,
  wants: string[],
  haves: string[],
  shallowSet: Set<string>,
  deepen: number | null,
): FetchPlan {
  const held = collectHeld(git, haves, shallowSet);
  const want = collectWant(git, wants, shallowSet, deepen);
  const send = new Set<string>();
  for (const sha of want.included) {
    if (!held.has(sha)) send.add(sha);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (deepen !== null) {
    for (const [oid, gen] of want.generation) {
      if (gen === deepen - 1) shallow.push(oid);
    }
    for (const oid of shallowSet) {
      const gen = want.generation.get(oid);
      if (gen !== undefined && gen < deepen - 1) unshallow.push(oid);
    }
    shallow.sort();
    unshallow.sort();
  }
  return { send, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// upload-pack: v2
// ---------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const { items } = parsePktLines(body, false);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (item.kind !== 'line') continue;
    const text = lineText(item);
    if (command === '') {
      if (!text.startsWith('command=')) throw new Error('v2 request without command');
      command = text.slice('command='.length);
      continue;
    }
    if (!seenDelim && (text.startsWith('agent=') || text.startsWith('object-format='))) {
      continue;
    }
    args.push(text);
  }
  if (command === '') throw new Error('v2 request without command');
  return { command, args };
}

function handleLsRefs(git: GitRepo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const matches = (ref: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const parts: Buffer[] = [];
  const mainTip = git.getRef(MAIN_REF);
  const names = sortedRefNames(git);
  if (names.length === 0) {
    if (unborn) {
      parts.push(pktLineStr('unborn HEAD symref-target:' + MAIN_REF));
    }
  } else {
    if (symrefs && mainTip !== undefined) {
      const headShown = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
      if (headShown) {
        parts.push(pktLineStr(mainTip + ' HEAD symref-target:' + MAIN_REF));
      }
    }
    for (const name of names) {
      if (!matches(name)) continue;
      const oid = git.getRef(name) as string;
      let line = oid + ' ' + name;
      if (peel && isTagObject(git, oid)) {
        line += ' peeled:' + peelToCommit(git, oid);
      }
      parts.push(pktLineStr(line));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let deepen: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallows.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action.
  }
  return { wants, haves, shallows, deepen };
}

function handleFetchV2(git: GitRepo, args: string[]): Buffer {
  const f = parseFetchArgs(args);
  const plan = planFetch(git, f.wants, f.haves, new Set(f.shallows), f.deepen);
  const pack = buildPackFromObjects(git, Array.from(plan.send));
  const parts: Buffer[] = [
    pktLineStr('acknowledgments'),
    pktLineStr('NAK'),
    pktDelim(),
  ];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLineStr('shallow-info'));
    for (const oid of plan.shallow) parts.push(pktLineStr('shallow ' + oid));
    for (const oid of plan.unshallow) parts.push(pktLineStr('unshallow ' + oid));
    parts.push(pktDelim());
  }
  parts.push(pktLineStr('packfile'));
  parts.push(sideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack: v0
// ---------------------------------------------------------------------------

function handleUploadV0(git: GitRepo, body: Buffer): Buffer {
  const { items } = parsePktLines(body, false);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let deepen: number | null = null;
  let section = 0;
  for (const item of items) {
    if (item.kind === 'flush') {
      section++;
      continue;
    }
    if (item.kind !== 'line') continue;
    const [text] = splitCaps(lineText(item));
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) deepen = n;
      }
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      // 'done': no action.
    }
  }
  const plan = planFetch(git, wants, haves, new Set(shallows), deepen);
  const pack = buildPackFromObjects(git, Array.from(plan.send));
  const parts: Buffer[] = [pktLineStr('NAK')];
  for (const oid of plan.shallow) parts.push(pktLineStr('shallow ' + oid));
  for (const oid of plan.unshallow) parts.push(pktLineStr('unshallow ' + oid));
  parts.push(sideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack: v0
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(git: GitRepo, body: Buffer): Buffer {
  const { items, consumed } = parsePktLines(body, true);
  const commands: PushCommand[] = [];
  let sideBand = false;
  for (const item of items) {
    if (item.kind !== 'line') continue;
    const [text, caps] = splitCaps(lineText(item));
    if (caps !== '') {
      const capList = caps.split(' ');
      if (capList.includes('side-band-64k')) sideBand = true;
    }
    const fields = text.split(' ');
    if (fields.length < 3) continue;
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack without commands');
  const packBytes = body.subarray(consumed);
  if (packBytes.length > 0) {
    parsePack(packBytes, git);
  }

  const results: string[] = [];
  for (const cmd of commands) {
    const current = git.getRef(cmd.ref);
    let ok = false;
    if (cmd.newOid === ZERO_OID) {
      // Delete: allowed when the ref exists and old matches its tip.
      if (current !== undefined && (cmd.oldOid === ZERO_OID || cmd.oldOid === current)) {
        git.deleteRef(cmd.ref);
        ok = true;
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create: allowed only when the ref does not exist yet.
      if (current === undefined) {
        if (git.getObject(cmd.newOid) !== undefined) {
          git.setRef(cmd.ref, cmd.newOid);
          ok = true;
        }
      }
    } else {
      // Update: old must match the tip and the new tip must descend from it.
      if (
        current !== undefined &&
        cmd.oldOid === current &&
        git.isAncestor(current, cmd.newOid) &&
        git.getObject(cmd.newOid) !== undefined
      ) {
        git.setRef(cmd.ref, cmd.newOid);
        ok = true;
      }
    }
    results.push(ok ? 'ok ' + cmd.ref : 'ng ' + cmd.ref + ' non-fast-forward');
  }

  const reportParts: Buffer[] = [pktLineStr('unpack ok')];
  for (const r of results) reportParts.push(pktLineStr(r));
  const report = Buffer.concat(reportParts);
  if (sideBand) {
    return Buffer.concat([sideband(report), pktFlush()]);
  }
  return Buffer.concat([report, pktFlush()]);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '', 'http://localhost');
  } catch {
    return false;
  }
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  // /{owner}/{repo}.git/info/refs | /{owner}/{repo}.git/git-upload-pack |
  // /{owner}/{repo}.git/git-receive-pack
  if (segments.length !== 3 && segments.length !== 4) return false;
  const [owner, repoGit] = segments;
  if (!repoGit.endsWith('.git')) return false;
  const repoName = repoGit.slice(0, -'.git'.length);
  let action = '';
  if (segments.length === 3) {
    action = segments[2];
  } else if (segments[2] === 'info' && segments[3] === 'refs') {
    action = 'info/refs';
  } else {
    return false;
  }
  const isInfoRefs = req.method === 'GET' && action === 'info/refs';
  const isUploadPack = req.method === 'POST' && action === 'git-upload-pack';
  const isReceivePack = req.method === 'POST' && action === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  if (!tokenValid(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  if (owner !== VIEWER_LOGIN) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const record = store.getRepo(owner, repoName);
  if (!record) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const git = record.git;

  try {
    if (isInfoRefs) {
      const service = url.searchParams.get('service') ?? '';
      if (service === 'git-receive-pack') {
        const caps =
          'symref=HEAD:' + MAIN_REF + ' report-status side-band-64k delete-refs';
        sendBuf(res, 200, v0Advertisement('git-receive-pack', git, caps), RECEIVE_AD_CT);
      } else if (service === 'git-upload-pack') {
        const proto = (req.headers['git-protocol'] ?? '').toString();
        if (proto === 'version=2') {
          sendBuf(res, 200, v2Advertisement(), UPLOAD_AD_CT);
        } else {
          const caps =
            'symref=HEAD:' + MAIN_REF + ' side-band-64k thin-pack ofs-delta';
          sendBuf(res, 200, v0Advertisement('git-upload-pack', git, caps), UPLOAD_AD_CT);
        }
      } else {
        // No service requested: answer a v0 upload-pack advertisement.
        const caps =
          'symref=HEAD:' + MAIN_REF + ' side-band-64k thin-pack ofs-delta';
        sendBuf(res, 200, v0Advertisement('git-upload-pack', git, caps), UPLOAD_AD_CT);
      }
      return true;
    }

    const body = await readBody(req);
    if (isUploadPack) {
      // v2 requests open with a `command=` pkt-line; v0 opens with `want`.
      // Peek at the first line to tell them apart (the Git-Protocol header
      // is a hint, but the body shape is decisive).
      const peek = parsePktLines(body, false).items.find((i) => i.kind === 'line');
      const text = peek ? lineText(peek) : '';
      if (text.startsWith('command=')) {
        const v2 = parseV2Request(body);
        if (v2.command === 'ls-refs') {
          sendBuf(res, 200, handleLsRefs(git, v2.args), UPLOAD_RESULT_CT);
        } else if (v2.command === 'fetch') {
          sendBuf(res, 200, handleFetchV2(git, v2.args), UPLOAD_RESULT_CT);
        } else {
          sendJson(res, 400, { message: 'unknown v2 command' });
        }
        return true;
      }
      sendBuf(res, 200, handleUploadV0(git, body), UPLOAD_RESULT_CT);
      return true;
    }

    // receive-pack
    sendBuf(res, 200, handleReceivePack(git, body), RECEIVE_RESULT_CT);
    return true;
  } catch (err) {
    // Malformed requests must never crash the server: answer 400 and stay up.
    const message = err instanceof Error ? err.message : 'bad request';
    sendJson(res, 400, { message });
    return true;
  }
}
