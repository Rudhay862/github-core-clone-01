// git.ts — git object model for the make.fun github-core-clone entry.
// Implements the object layer (sha1 ids, blob/tree/commit/tag) plus a small
// in-memory repository (objects + refs) used by the pack and HTTP layers.
// Only node:crypto and node:zlib are used. No wall clock, no randomness.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const SHA1_HEX = /^[0-9a-f]{40}$/;

export function isOid(s: string): boolean {
  return SHA1_HEX.test(s);
}

/** sha1 hex of `<type> <len>\0<body>` — the git object id. */
export function hashObject(type: GitObjectType, body: Buffer): string {
  const header = Buffer.from(type + ' ' + body.length + '\0', 'ascii');
  return createHash('sha1').update(header).update(body).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a raw tree body into entries (mode, name, 20-byte oid). */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = body.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > body.length) break;
    const mode = body.toString('ascii', off, sp);
    const name = body.toString('utf8', sp + 1, nul);
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Git tree sort: compare entry names byte-wise, with directory names
 *  treated as if they carried a trailing '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const ka = a.mode === '40000' ? a.name + '/' : a.name;
  const kb = b.mode === '40000' ? b.name + '/' : b.name;
  const ba = Buffer.from(ka, 'utf8');
  const bb = Buffer.from(kb, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/** Serialize entries into a raw tree body, sorted in git tree order. */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const head = Buffer.from(e.mode + ' ' + e.name + '\0', 'utf8');
    const oid = Buffer.from(e.sha, 'hex');
    parts.push(head, oid);
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

/** Parse a raw commit body. Header lines run until the first blank line;
 *  everything after it is the message (kept byte-exact via the raw buffer). */
export function parseCommit(body: Buffer): ParsedCommit {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: body };
}

export interface CommitInput {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Serialize a commit. The message is written exactly as given (callers
 *  include its trailing newline); no bytes are added or stripped. */
export function serializeCommit(c: CommitInput): Buffer {
  let out = 'tree ' + c.tree + '\n';
  for (const p of c.parents) out += 'parent ' + p + '\n';
  out += 'author ' + c.author + '\n';
  out += 'committer ' + c.committer + '\n';
  out += '\n' + c.message;
  return Buffer.from(out, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
  raw: Buffer;
}

/** Parse a raw annotated-tag body. */
export function parseTag(body: Buffer): ParsedTag {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message, raw: body };
}

export interface TagInput {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Serialize an annotated tag, message written exactly as given. */
export function serializeTag(t: TagInput): Buffer {
  let out = 'object ' + t.object + '\n';
  out += 'type ' + t.type + '\n';
  out += 'tag ' + t.tag + '\n';
  out += 'tagger ' + t.tagger + '\n';
  out += '\n' + t.message;
  return Buffer.from(out, 'utf8');
}

export interface GitRepo {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  getObject(sha: string): GitObject | undefined;
  putObject(type: GitObjectType, body: Buffer): string;
  getRef(name: string): string | undefined;
  setRef(name: string, sha: string): void;
  deleteRef(name: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
}

/** Create an empty in-memory repository. */
export function createGitRepo(): GitRepo {
  const objects = new Map<string, GitObject>();
  const refs = new Map<string, string>();

  function getObject(sha: string): GitObject | undefined {
    return objects.get(sha);
  }

  function putObject(type: GitObjectType, body: Buffer): string {
    const sha = hashObject(type, body);
    if (!objects.has(sha)) objects.set(sha, { type, body });
    return sha;
  }

  function getRef(name: string): string | undefined {
    return refs.get(name);
  }

  function setRef(name: string, sha: string): void {
    refs.set(name, sha);
  }

  function deleteRef(name: string): boolean {
    return refs.delete(name);
  }

  /** True when `ancestor` is reachable from `descendant` by walking commit
   *  parents; the same oid counts as its own ancestor. Missing objects
   *  (or non-commit tips) yield false. */
  function isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID || descendant === ZERO_OID) return false;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.body);
      for (const p of parsed.parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  return { objects, refs, getObject, putObject, getRef, setRef, deleteRef, isAncestor };
}
