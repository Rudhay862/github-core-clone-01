// pack.ts — packfile parsing/generation, pkt-line framing and sideband.
// Packs are version 2 on write (plain objects, no deltas); reads accept
// version 2/3 and resolve both OFS_DELTA and REF_DELTA entries.
// Only node:crypto and node:zlib are used. No wall clock, no randomness.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import {
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
} from './git.ts';
import type { GitObjectType, GitRepo } from './git.ts';

// Pack entry type codes (same numbering as the pack object header).
const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_BY_CODE: Record<number, GitObjectType> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

const CODE_BY_TYPE: Record<GitObjectType, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

/** Apply a git delta to a base buffer. Delta layout: source-size varint,
 *  target-size varint, then copy (high bit set) / insert ops. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;

  function readVarint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  }

  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      // Copy from base: offset/size bytes follow per set bits.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          offset |= delta[pos++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          size |= delta[pos++] << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      // Insert literal bytes.
      if (pos + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      outLen += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (outLen !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out, outLen);
}

interface RawPackEntry {
  code: number;
  start: number; // byte offset of this entry's type/size header in the pack
  baseOffset: number; // for OFS_DELTA: distance back to the base entry
  baseSha: string; // for REF_DELTA: base object id ('' otherwise)
  data: Buffer; // inflated payload (delta bytes for delta entries)
}

/** Parse a v2/v3 pack, resolve deltas, store every object in `git`, and
 *  return the shas of the objects this pack added, in pack order. */
export function parsePack(buf: Buffer, git: GitRepo): string[] {
  if (buf.length < 12) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + version);
  const count = buf.readUInt32BE(8);

  const entries: RawPackEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    if (pos >= buf.length) throw new Error('pack truncated in entry header');
    let byte = buf[pos++];
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= buf.length) throw new Error('pack truncated in size varint');
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseSha = '';
    if (code === OBJ_OFS_DELTA) {
      // Git's offset encoding: bytes are base-128 with a +1 bias per byte.
      if (pos >= buf.length) throw new Error('pack truncated in ofs-delta offset');
      byte = buf[pos++];
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= buf.length) throw new Error('pack truncated in ofs-delta offset');
        byte = buf[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = offset;
    } else if (code === OBJ_REF_DELTA) {
      if (pos + 20 > buf.length) throw new Error('pack truncated in ref-delta base');
      baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (TYPE_BY_CODE[code] === undefined) {
      throw new Error('unknown pack object type ' + code);
    }
    // The payload is one zlib stream starting at pos. inflateSync ignores
    // trailing bytes but throws on a truncated stream, so the stream's exact
    // length is the shortest prefix that inflates cleanly (binary search).
    const streamLen = zlibStreamLength(buf.subarray(pos));
    const inflated = inflateSync(buf.subarray(pos, pos + streamLen));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    pos += streamLen;
    entries.push({ code, start: entryStart, baseOffset, baseSha, data: inflated });
  }

  // Resolve entries in order; a delta base always precedes its delta in a
  // well-formed pack, but retry unresolved ones so out-of-order packs work.
  const resolved = new Map<number, { type: GitObjectType; body: Buffer; sha: string }>();
  const byOffset = new Map<number, number>();
  for (let i = 0; i < entries.length; i++) byOffset.set(entries[i].start, i);
  const added: string[] = [];
  let remaining = entries.map((_, i) => i);
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    const next: number[] = [];
    for (const idx of remaining) {
      const e = entries[idx];
      if (e.code === OBJ_OFS_DELTA || e.code === OBJ_REF_DELTA) {
        let base: { type: GitObjectType; body: Buffer } | undefined;
        if (e.code === OBJ_OFS_DELTA) {
          const baseIdx = byOffset.get(e.start - e.baseOffset);
          if (baseIdx !== undefined) base = resolved.get(baseIdx);
        } else {
          const stored = git.getObject(e.baseSha);
          if (stored) base = stored;
          else {
            // Base may be another entry in this same pack.
            for (const r of resolved.values()) {
              if (r.sha === e.baseSha) base = r;
            }
          }
        }
        if (!base) {
          next.push(idx);
          continue;
        }
        const body = applyDelta(base.body, e.data);
        const sha = hashObject(base.type, body);
        resolved.set(idx, { type: base.type, body, sha });
        if (!git.getObject(sha)) {
          git.objects.set(sha, { type: base.type, body });
          added.push(sha);
        }
        progress = true;
      } else {
        const type = TYPE_BY_CODE[e.code] as GitObjectType;
        const sha = hashObject(type, e.data);
        resolved.set(idx, { type, body: e.data, sha });
        if (!git.getObject(sha)) {
          git.objects.set(sha, { type, body: e.data });
          added.push(sha);
        }
        progress = true;
      }
    }
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('unresolved delta base in pack');
  // Return the added shas in pack order.
  const addedInOrder: string[] = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const r = resolved.get(idx);
    if (r && added.includes(r.sha) && !addedInOrder.includes(r.sha)) addedInOrder.push(r.sha);
  }
  return addedInOrder;
}

/** Length in bytes of the zlib stream at the start of `buf`. Node's
 *  inflateSync ignores trailing bytes but throws on a truncated stream,
 *  so success is monotonic in prefix length and the first successful
 *  prefix is exactly the stream end. */
function zlibStreamLength(buf: Buffer): number {
  let lo = 1;
  let hi = buf.length;
  // Find the first length that inflates cleanly.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  // Verify the candidate really is a complete stream.
  inflateSync(buf.subarray(0, lo));
  return lo;
}

/** Full reachable closure of `want` (commits, their trees/blobs, tag
 *  targets), as a set of object ids present in `git`. */
export function collectClosure(git: GitRepo, want: string[]): Set<string> {
  const found = new Set<string>();
  const stack: string[] = want.slice();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (found.has(sha)) continue;
    const obj = git.getObject(sha);
    if (!obj) continue;
    found.add(sha);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.body);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.body)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.body).object);
    }
  }
  return found;
}

/** Build a pack from an explicit set of object ids (sorted ascending).
 *  Plain objects only, no deltas. */
export function buildPackFromObjects(git: GitRepo, shas: string[]): Buffer {
  const sorted = shas.slice().sort();
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  chunks.push(header);
  for (const sha of sorted) {
    const obj = git.getObject(sha);
    if (!obj) continue;
    const code = CODE_BY_TYPE[obj.type];
    const size = obj.body.length;
    // Type+size varint: first byte holds type and low 4 size bits.
    const headBytes: number[] = [];
    let remaining = size >>> 4;
    headBytes.push(((code & 0x07) << 4) | (size & 0x0f) | (remaining > 0 ? 0x80 : 0));
    while (remaining > 0) {
      const next = remaining >>> 7;
      headBytes.push((remaining & 0x7f) | (next > 0 ? 0x80 : 0));
      remaining = next;
    }
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(obj.body));
  }
  const withoutTrailer = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Build a self-contained pack (v2, no deltas) of the closure of `want`.
 *  Object order is sorted by sha ascending, so output is deterministic. */
export function buildPack(git: GitRepo, want: string[]): Buffer {
  const closure = collectClosure(git, want);
  return buildPackFromObjects(git, Array.from(closure));
}

/** One pkt-line: 4-hex length prefix (including the 4 bytes) + payload. */
export function pktLine(s: string | Buffer): Buffer {
  const payload = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = payload.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, payload]);
}

/** The flush pkt-line `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim pkt-line `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** A pkt-line carrying one text line (payload is the string + `\n`). */
export function pktLineStr(s: string): Buffer {
  return pktLine(s + '\n');
}

const SIDEBAND_MAX_PAYLOAD = 65516; // 65520 pkt-line max minus 4-byte prefix

/** Frame bytes as sideband band 1 (data), with optional band-2 progress
 *  lines. Each frame is one pkt-line starting with a 1-byte band number. */
export function sideband(data: Buffer, progress?: string): Buffer {
  const frames: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const chunk = data.subarray(off, off + SIDEBAND_MAX_PAYLOAD - 1);
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  if (progress !== undefined && progress.length > 0) {
    for (const line of progress.split('\n')) {
      if (line.length === 0) continue;
      frames.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(line + '\n', 'utf8')])));
    }
  }
  return Buffer.concat(frames);
}

/** Frame a single error line as sideband band 3. */
export function sidebandError(message: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(message + '\n', 'utf8')]));
}
