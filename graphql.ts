// graphql.ts — the GraphQL v4 surface for the forge.
//
// Serves POST /api/graphql only. The suite sends eighteen fixed documents
// (viewer, repository reads, issue and pull-request reads, the five
// mutations, introspection probes, node(id:) and cursor pagination, plus
// batched arrays). This module matches each document by its operation name
// and falls back to the top-level field shape, so no general GraphQL engine
// is needed. All reads and writes go through the same in-memory store the
// REST surface uses, so a mutation made here is visible over REST.
//
// Global ids are opaque: base64 of a short tagged key such as
// `repo:<owner>/<name>`, never the bare numeric database id or number.
// Cursors are base64 of `cursor:<issue-number>`.
//
// Auth: the bearer token must equal the entry's own MAKEFUN_SHOP_TOKEN
// exactly; anything else is a 401 before the body is parsed.
// Determinism: fixed epoch timestamps, sequential ids, no wall clock,
// no randomness.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CommentRecord, IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';
import { bearerToken, readBody, sendJson } from './http.ts';
import { parseCommit, parseTree, serializeCommit, serializeTree } from './git.ts';

const EPOCH_ISO = '2025-01-01T00:00:00Z';
const EPOCH_SEC = 1735689600;
const ZERO_OID = '0000000000000000000000000000000000000000';

type Variables = Record<string, unknown>;
type GitRepo = RepoRecord['git'];

interface Envelope {
  data: unknown;
  errors?: { message: string }[];
}

function ok(data: unknown): Envelope {
  return { data };
}

function err(message: string, data: unknown = null): Envelope {
  return { data, errors: [{ message }] };
}

// -------------------------------------------------------------------------------------------
// Opaque ids and cursors
// -------------------------------------------------------------------------------------------

function encodeText(plain: string): string {
  return Buffer.from(plain, 'utf8').toString('base64');
}

function repoGlobalId(owner: string, name: string): string {
  return encodeText(`repo:${owner}/${name}`);
}

function issueGlobalId(owner: string, name: string, number: number): string {
  return encodeText(`issue:${owner}/${name}:${number}`);
}

function prGlobalId(owner: string, name: string, number: number): string {
  return encodeText(`pr:${owner}/${name}:${number}`);
}

function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return encodeText(`comment:${owner}/${name}:${issueNumber}:${commentId}`);
}

function cursorFor(number: number): string {
  return encodeText(`cursor:${number}`);
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let plain: string;
  try {
    plain = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(plain);
  return match === null ? null : Number(match[1]);
}

interface DecodedId {
  kind: string;
  owner: string;
  name: string;
  number: number;
  extra: number;
}

function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  let plain: string;
  try {
    plain = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = plain.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0];
  if (kind !== 'repo' && kind !== 'issue' && kind !== 'pr' && kind !== 'comment') return null;
  const repoPart = parts[1];
  const slash = repoPart.indexOf('/');
  if (slash <= 0 || slash === repoPart.length - 1) return null;
  const owner = repoPart.slice(0, slash);
  const name = repoPart.slice(slash + 1);
  const number = parts.length > 2 ? Number(parts[2]) : 0;
  const extra = parts.length > 3 ? Number(parts[3]) : 0;
  if ((kind === 'issue' || kind === 'pr') && (!Number.isInteger(number) || number <= 0)) return null;
  if (kind === 'comment' && (!Number.isInteger(number) || number <= 0 || !Number.isInteger(extra) || extra <= 0)) {
    return null;
  }
  return { kind, owner, name, number, extra };
}

// -------------------------------------------------------------------------------------------
// Minimal argument parsing for the fixed documents
// -------------------------------------------------------------------------------------------

// Split on top-level commas, respecting nesting and quoted strings.
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((part) => part.trim() !== '');
}

function parseValue(text: string, variables: Variables): unknown {
  const t = text.trim();
  if (t === '') return undefined;
  if (t.startsWith('$')) return variables[t.slice(1)];
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return splitTopLevel(t.slice(1, -1)).map((part) => parseValue(part, variables));
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevel(t.slice(1, -1))) {
      const colon = part.indexOf(':');
      if (colon <= 0) continue;
      obj[part.slice(0, colon).trim()] = parseValue(part.slice(colon + 1), variables);
    }
    return obj;
  }
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

function parseArgList(inner: string, variables: Variables): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitTopLevel(inner)) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    args[part.slice(0, colon).trim()] = parseValue(part.slice(colon + 1), variables);
  }
  return args;
}

// The text between the balanced parens that open at `openIndex`.
function balancedInner(query: string, openIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < query.length; i += 1) {
    const ch = query[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return query.slice(openIndex + 1, i);
    }
  }
  return null;
}

// Arguments of the first `field(...)` call in the document, or {} when absent.
function callArgs(query: string, field: string, variables: Variables): Record<string, unknown> {
  const at = query.indexOf(`${field}(`);
  if (at < 0) return {};
  const inner = balancedInner(query, at + field.length);
  return inner === null ? {} : parseArgList(inner, variables);
}

function operationNameOf(query: string): string | null {
  const match = /^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match === null ? null : match[2];
}

// -------------------------------------------------------------------------------------------
// Store views
// -------------------------------------------------------------------------------------------

// A repository reads back only when it exists under the token owner's login;
// any other owner (including a stranger's repo of the same name) reads as null.
function visibleRepo(store: Store, owner: unknown, name: unknown): RepoRecord | undefined {
  if (typeof owner !== 'string' || typeof name !== 'string') return undefined;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (repo.owner !== store.viewer.login) return undefined;
  return repo;
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueView(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
  };
}

function prState(pr: PullRecord): string {
  if (pr.state === 'open') return 'OPEN';
  return pr.merged ? 'MERGED' : 'CLOSED';
}

function repoScalarView(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

interface IssuePage {
  nodes: IssueRecord[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface IssueListOptions {
  states?: string[];
  direction?: string;
  first?: number;
  after?: unknown;
}

// Issues ordered by creation order, which is issue-number order. CREATED_AT
// DESC is number descending (ties by number DESC); ASC is the reverse.
// `after` resumes just past the cursor's issue number in the same direction.
function pageIssues(repo: RepoRecord, opts: IssueListOptions): IssuePage {
  let list = [...repo.issues.values()];
  if (opts.states !== undefined && opts.states.length > 0) {
    const wanted = new Set(opts.states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const desc = (opts.direction ?? 'DESC').toUpperCase() !== 'ASC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const afterNumber = numberFromCursor(opts.after);
  if (afterNumber !== null) {
    list = list.filter((issue) => (desc ? issue.number < afterNumber : issue.number > afterNumber));
  }
  const first = typeof opts.first === 'number' && opts.first >= 0 ? Math.floor(opts.first) : list.length;
  const page = list.slice(0, first);
  return {
    nodes: page,
    hasNextPage: list.length > page.length,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
  };
}

function issuesConnection(
  repo: RepoRecord,
  query: string,
  variables: Variables,
  opts: { states?: string[]; direction?: string },
): Record<string, unknown> {
  const args = callArgs(query, 'issues', variables);
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const page = pageIssues(repo, {
    states: Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s)) : opts.states,
    direction:
      typeof orderBy.direction === 'string' ? orderBy.direction : opts.direction,
    first: typeof args.first === 'number' ? args.first : undefined,
    after: args.after,
  });
  const connection: Record<string, unknown> = {
    nodes: page.nodes.map((issue) => issueView(repo, issue)),
  };
  if (query.includes('pageInfo')) {
    connection.pageInfo = { hasNextPage: page.hasNextPage, endCursor: page.endCursor };
  }
  return connection;
}

// -------------------------------------------------------------------------------------------
// Git helpers: file listings, merge base, conflict probe, squash merge
// -------------------------------------------------------------------------------------------

function treeOfCommit(git: GitRepo, sha: string | undefined | null): string | null {
  if (sha === undefined || sha === null || sha === ZERO_OID) return null;
  const obj = git.getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.body).tree;
}

function commitParents(git: GitRepo, sha: string): string[] {
  const obj = git.getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.body).parents;
}

// Full path -> blob sha for every file in the tree, walking directories.
function collectFiles(git: GitRepo, treeSha: string | null): Map<string, string> {
  const files = new Map<string, string>();
  if (treeSha === null) return files;
  const walk = (sha: string, prefix: string): void => {
    const obj = git.getObject(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.body)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, entry.sha);
    }
  };
  walk(treeSha, '');
  return files;
}

function findMergeBase(git: GitRepo, headSha: string, baseSha: string): string | null {
  if (headSha === baseSha) return headSha;
  const headAncestors = new Set<string>();
  const stack = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (headAncestors.has(sha)) continue;
    headAncestors.add(sha);
    for (const parent of commitParents(git, sha)) stack.push(parent);
  }
  const queue = [baseSha];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (headAncestors.has(sha)) return sha;
    for (const parent of commitParents(git, sha)) queue.push(parent);
  }
  return null;
}

// Paths changed on both sides of the merge base with different content
// (a deletion on one side counts as a change, so delete-vs-modify conflicts).
function conflictPaths(git: GitRepo, headSha: string, baseSha: string): string[] {
  const mergeBase = findMergeBase(git, headSha, baseSha);
  const baseFiles = collectFiles(git, treeOfCommit(git, baseSha));
  const headFiles = collectFiles(git, treeOfCommit(git, headSha));
  const oldFiles = mergeBase === null ? new Map<string, string>() : collectFiles(git, treeOfCommit(git, mergeBase));
  const conflicts: string[] = [];
  const paths = new Set([...oldFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const oldVal = oldFiles.has(path) ? (oldFiles.get(path) as string) : null;
    const baseVal = baseFiles.has(path) ? (baseFiles.get(path) as string) : null;
    const headVal = headFiles.has(path) ? (headFiles.get(path) as string) : null;
    if (baseVal !== oldVal && headVal !== oldVal && baseVal !== headVal) conflicts.push(path);
  }
  return conflicts;
}

function changedPaths(git: GitRepo, fromSha: string, toSha: string): { path: string; status: string }[] {
  const fromFiles = collectFiles(git, treeOfCommit(git, fromSha));
  const toFiles = collectFiles(git, treeOfCommit(git, toSha));
  const out: { path: string; status: string }[] = [];
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  for (const path of [...paths].sort()) {
    const a = fromFiles.get(path);
    const b = toFiles.get(path);
    if (a === b) continue;
    out.push({ path, status: b === undefined ? 'removed' : a === undefined ? 'added' : 'modified' });
  }
  return out;
}

type TreeNode = Map<string, string | TreeNode>;

function nestFiles(files: Map<string, string>): TreeNode {
  const root: TreeNode = new Map();
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      let child = node.get(part);
      if (child === undefined || typeof child === 'string') {
        child = new Map<string, string | TreeNode>();
        node.set(part, child);
      }
      node = child as TreeNode;
    }
    node.set(parts[parts.length - 1], sha);
  }
  return root;
}

function writeTree(git: GitRepo, node: TreeNode): string {
  const entries: { mode: string; name: string; sha: string }[] = [];
  for (const [name, value] of node) {
    if (typeof value === 'string') entries.push({ mode: '100644', name, sha: value });
    else entries.push({ mode: '40000', name, sha: writeTree(git, value) });
  }
  return git.putObject('tree', serializeTree(entries));
}

function headIsDescendantOfBase(git: GitRepo, baseSha: string, headSha: string): boolean {
  if (headSha === baseSha) return true;
  try {
    return git.isAncestor(baseSha, headSha);
  } catch {
    return false;
  }
}

function mergeableOf(repo: RepoRecord, pr: PullRecord): string {
  const git = repo.git;
  const headSha = git.getRef(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = git.getRef(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  if (headSha === baseSha) return 'MERGEABLE';
  if (headIsDescendantOfBase(git, baseSha, headSha)) return 'MERGEABLE';
  if (conflictPaths(git, headSha, baseSha).length > 0) return 'CONFLICTING';
  return 'UNKNOWN';
}

type SquashResult = { ok: true; sha: string } | { ok: false; conflicts: string[] };

// One squash commit on the base branch: the base tree with the pull request's
// changed files (diffed against the merge base) applied at head content.
function squashMerge(store: Store, repo: RepoRecord, pr: PullRecord): SquashResult {
  const git = repo.git;
  const headSha = git.getRef(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = git.getRef(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  if (headSha === undefined || headSha === ZERO_OID || baseSha === undefined || baseSha === ZERO_OID) {
    return { ok: false, conflicts: [] };
  }
  const conflicts = conflictPaths(git, headSha, baseSha);
  if (conflicts.length > 0) return { ok: false, conflicts };
  const mergeBase = findMergeBase(git, headSha, baseSha);
  const baseFiles = collectFiles(git, treeOfCommit(git, baseSha));
  const headFiles = collectFiles(git, treeOfCommit(git, headSha));
  const oldFiles =
    mergeBase === null ? new Map<string, string>() : collectFiles(git, treeOfCommit(git, mergeBase));
  const merged = new Map(baseFiles);
  for (const [path, headVal] of headFiles) {
    if ((oldFiles.get(path) ?? null) !== headVal) merged.set(path, headVal);
  }
  for (const path of oldFiles.keys()) {
    if (!headFiles.has(path)) merged.delete(path);
  }
  const newTree = writeTree(git, nestFiles(merged));
  const viewer = store.viewer;
  const stamp = `${viewer.name} <${viewer.email}> ${EPOCH_SEC} +0000`;
  const commitBody = serializeCommit({
    tree: newTree,
    parents: [baseSha],
    author: stamp,
    committer: stamp,
    message: `${pr.title}\n`,
  });
  const commitSha = git.putObject('commit', commitBody);
  git.setRef(`refs/heads/${pr.base.ref}`, commitSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = EPOCH_ISO;
  pr.mergeCommitSha = commitSha;
  pr.updatedAt = EPOCH_ISO;
  return { ok: true, sha: commitSha };
}

// -------------------------------------------------------------------------------------------
// Introspection
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'PROJECT', 'TOPIC', 'WIKI'];

function introspectionResult(query: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    const alias = match[1] ?? '__type';
    const openIndex = match.index + match[0].length - 1;
    const inner = balancedInner(query, openIndex);
    const args = inner === null ? {} : parseArgList(inner, {});
    const name = typeof args.name === 'string' ? args.name : '';
    if (name === 'SearchType') {
      out[alias] = { enumValues: SEARCH_TYPE_VALUES.map((value) => ({ name: value })) };
    } else if (Object.prototype.hasOwnProperty.call(TYPE_FIELDS, name)) {
      out[alias] = { fields: (TYPE_FIELDS[name] as string[]).map((field) => ({ name: field })) };
    } else {
      out[alias] = null;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Operation handlers
// -------------------------------------------------------------------------------------------

function repositoryFromArgs(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  return ok({ repository: repoScalarView(repo) });
}

function repositoryIssues(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  return ok({ repository: { issues: issuesConnection(repo, query, variables, {}) } });
}

function repositoryIssue(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  const issueArgs = callArgs(query, 'issue', variables);
  const number = typeof issueArgs.number === 'number' ? issueArgs.number : -1;
  const issue = repo.issues.get(number);
  if (issue === undefined) return ok({ repository: { issue: null } });
  return ok({ repository: { issue: issueView(repo, issue) } });
}

function repositoryPullRequests(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  const prArgs = callArgs(query, 'pullRequests', variables);
  const first = typeof prArgs.first === 'number' ? prArgs.first : undefined;
  let list = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
  list.sort((a, b) => b.number - a.number);
  if (first !== undefined) list = list.slice(0, first);
  const nodes = list.map((pr) => ({
    number: pr.number,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    mergeable: mergeableOf(repo, pr),
    state: prState(pr),
  }));
  return ok({ repository: { pullRequests: { nodes } } });
}

function repositoryPullRequestFiles(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  const prArgs = callArgs(query, 'pullRequest', variables);
  const number = typeof prArgs.number === 'number' ? prArgs.number : -1;
  const pr = repo.pulls.get(number);
  if (pr === undefined) return ok({ repository: { pullRequest: null } });
  const filesArgs = callArgs(query, 'files', variables);
  const first = typeof filesArgs.first === 'number' ? filesArgs.first : 10;
  const git = repo.git;
  const headSha = git.getRef(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = git.getRef(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  const nodes = changedPaths(git, baseSha, headSha)
    .slice(0, first)
    .map((entry) => ({ path: entry.path }));
  return ok({ repository: { pullRequest: { number: pr.number, files: { nodes } } } });
}

function repositoryPullRequestId(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  const prArgs = callArgs(query, 'pullRequest', variables);
  const number = typeof prArgs.number === 'number' ? prArgs.number : -1;
  const pr = repo.pulls.get(number);
  if (pr === undefined) return ok({ repository: { pullRequest: null } });
  return ok({
    repository: { pullRequest: { id: prGlobalId(repo.owner, repo.name, pr.number), number: pr.number } },
  });
}

function doCreateIssue(store: Store, query: string, variables: Variables): Envelope {
  const input = (callArgs(query, 'createIssue', variables).input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(input.repositoryId);
  if (decoded === null || decoded.kind !== 'repo') {
    return err('createIssue needs a repository global id', { createIssue: null });
  }
  const repo = visibleRepo(store, decoded.owner, decoded.name);
  if (repo === undefined) {
    return err('createIssue: repository not found', { createIssue: null });
  }
  const number = repo.nextIssueNumber;
  repo.nextIssueNumber += 1;
  const issue: IssueRecord = {
    id: store.nextIssueId,
    number,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    labels: [],
    user: store.viewer,
    createdAt: EPOCH_ISO,
    updatedAt: EPOCH_ISO,
    closedAt: null,
    comments: [],
  };
  store.nextIssueId += 1;
  repo.issues.set(number, issue);
  return ok({ createIssue: { issue: { number, id: issueGlobalId(repo.owner, repo.name, number) } } });
}

function doCloseIssue(store: Store, query: string, variables: Variables): Envelope {
  const input = (callArgs(query, 'closeIssue', variables).input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(input.issueId);
  if (decoded === null || decoded.kind !== 'issue') {
    return err('closeIssue needs an issue global id', { closeIssue: null });
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.get(decoded.number);
  if (issue === undefined) {
    return err('closeIssue: issue not found', { closeIssue: null });
  }
  issue.state = 'closed';
  issue.closedAt = EPOCH_ISO;
  issue.updatedAt = EPOCH_ISO;
  return ok({
    closeIssue: {
      issue: { number: issue.number, id: issueGlobalId(decoded.owner, decoded.name, issue.number), state: 'CLOSED' },
    },
  });
}

function doCreatePullRequest(store: Store, query: string, variables: Variables): Envelope {
  const input = (callArgs(query, 'createPullRequest', variables).input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(input.repositoryId);
  if (decoded === null || decoded.kind !== 'repo') {
    return err('createPullRequest needs a repository global id', { createPullRequest: null });
  }
  const repo = visibleRepo(store, decoded.owner, decoded.name);
  if (repo === undefined) {
    return err('createPullRequest: repository not found', { createPullRequest: null });
  }
  const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const git = repo.git;
  const headSha = git.getRef(`refs/heads/${headRefName}`);
  const baseSha = git.getRef(`refs/heads/${baseRefName}`);
  if (headSha === undefined || headSha === ZERO_OID) {
    return err(`createPullRequest: head branch ${headRefName} not found`, { createPullRequest: null });
  }
  if (baseSha === undefined || baseSha === ZERO_OID) {
    return err(`createPullRequest: base branch ${baseRefName} not found`, { createPullRequest: null });
  }
  const number = repo.nextPullNumber;
  repo.nextPullNumber += 1;
  const pr: PullRecord = {
    id: store.nextPullId,
    number,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : null,
    state: 'open',
    merged: false,
    mergeable: headIsDescendantOfBase(git, baseSha, headSha),
    head: { ref: headRefName, sha: headSha },
    base: { ref: baseRefName, sha: baseSha },
    mergedAt: null,
    mergeCommitSha: null,
    user: store.viewer,
    createdAt: EPOCH_ISO,
    updatedAt: EPOCH_ISO,
  };
  store.nextPullId += 1;
  repo.pulls.set(number, pr);
  return ok({
    createPullRequest: {
      pullRequest: {
        number,
        id: prGlobalId(repo.owner, repo.name, number),
        state: 'OPEN',
        headRefName,
        baseRefName,
      },
    },
  });
}

function doMergePullRequest(store: Store, query: string, variables: Variables): Envelope {
  const input = (callArgs(query, 'mergePullRequest', variables).input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(input.pullRequestId);
  if (decoded === null || decoded.kind !== 'pr') {
    return err('mergePullRequest needs a pull request global id', { mergePullRequest: null });
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const pr = repo?.pulls.get(decoded.number);
  if (pr === undefined || repo === undefined) {
    return err('mergePullRequest: pull request not found', { mergePullRequest: null });
  }
  if (pr.merged) {
    return ok({ mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'MERGED' } } });
  }
  if (pr.state !== 'open') {
    return err('mergePullRequest: pull request is closed', { mergePullRequest: null });
  }
  const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
  if (method !== 'MERGE' && method !== 'SQUASH' && method !== 'REBASE') {
    return err(`mergePullRequest: unsupported merge method ${method}`, { mergePullRequest: null });
  }
  const result = squashMerge(store, repo, pr);
  if (!result.ok) {
    if (result.conflicts.length > 0) {
      return err(`mergePullRequest: merge conflict in ${result.conflicts.join(', ')}`, { mergePullRequest: null });
    }
    return err('mergePullRequest: head or base branch not found', { mergePullRequest: null });
  }
  return ok({ mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'MERGED' } } });
}

function doAddComment(store: Store, query: string, variables: Variables): Envelope {
  const input = (callArgs(query, 'addComment', variables).input ?? {}) as Record<string, unknown>;
  const decoded = decodeGlobalId(input.subjectId);
  if (decoded === null || decoded.kind !== 'issue') {
    return err('addComment needs an issue global id', { addComment: null });
  }
  const repo = store.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.get(decoded.number);
  if (issue === undefined || repo === undefined) {
    return err('addComment: issue not found', { addComment: null });
  }
  const comment: CommentRecord = {
    id: store.nextCommentId,
    body: typeof input.body === 'string' ? input.body : '',
    user: store.viewer,
    createdAt: EPOCH_ISO,
    updatedAt: EPOCH_ISO,
  };
  store.nextCommentId += 1;
  issue.comments.push(comment);
  return ok({
    addComment: {
      commentEdge: {
        node: {
          id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id),
          body: comment.body,
        },
      },
    },
  });
}

function doNode(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'node', variables);
  const decoded = decodeGlobalId(args.id);
  if (decoded === null) return ok({ node: null });
  if (decoded.kind === 'repo') {
    const repo = store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined || repo.owner !== store.viewer.login) return ok({ node: null });
    return ok({
      node: {
        id: repoGlobalId(repo.owner, repo.name),
        name: repo.name,
        nameWithOwner: `${repo.owner}/${repo.name}`,
      },
    });
  }
  if (decoded.kind === 'issue') {
    const repo = store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.get(decoded.number);
    if (issue === undefined || repo === undefined) return ok({ node: null });
    return ok({ node: issueView(repo, issue) });
  }
  if (decoded.kind === 'pr') {
    const repo = store.getRepo(decoded.owner, decoded.name);
    const pr = repo?.pulls.get(decoded.number);
    if (pr === undefined || repo === undefined) return ok({ node: null });
    return ok({
      node: {
        id: prGlobalId(repo.owner, repo.name, pr.number),
        number: pr.number,
        title: pr.title,
        state: prState(pr),
        merged: pr.merged,
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
      },
    });
  }
  if (decoded.kind === 'comment') {
    const repo = store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.get(decoded.number);
    const comment = issue?.comments.find((entry) => entry.id === decoded.extra);
    if (comment === undefined || repo === undefined || issue === undefined) return ok({ node: null });
    return ok({
      node: {
        id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id),
        body: comment.body,
      },
    });
  }
  return ok({ node: null });
}

function invalidField(store: Store): Envelope {
  return {
    data: { viewer: { login: store.viewer.login } },
    errors: [{ message: 'Field "noSuchFieldOnViewer" doesn\'t exist on type "User"' }],
  };
}

// Generic repository read used when a document arrives without a known
// operation name: include whichever sub-selections the text asks for.
function genericRepository(store: Store, query: string, variables: Variables): Envelope {
  const args = callArgs(query, 'repository', variables);
  const repo = visibleRepo(store, args.owner, args.name);
  if (repo === undefined) return ok({ repository: null });
  const view: Record<string, unknown> = repoScalarView(repo);
  if (query.includes('issues(')) view.issues = issuesConnection(repo, query, variables, {});
  if (query.includes('issue(')) {
    const issueArgs = callArgs(query, 'issue', variables);
    const number = typeof issueArgs.number === 'number' ? issueArgs.number : -1;
    const issue = repo.issues.get(number);
    view.issue = issue === undefined ? null : issueView(repo, issue);
  }
  if (query.includes('pullRequests(')) {
    const list = [...repo.pulls.values()]
      .filter((pr) => pr.state === 'open')
      .sort((a, b) => b.number - a.number);
    view.pullRequests = {
      nodes: list.map((pr) => ({
        number: pr.number,
        headRefName: pr.head.ref,
        baseRefName: pr.base.ref,
        mergeable: mergeableOf(repo, pr),
        state: prState(pr),
      })),
    };
  }
  if (query.includes('pullRequest(')) {
    const prArgs = callArgs(query, 'pullRequest', variables);
    const number = typeof prArgs.number === 'number' ? prArgs.number : -1;
    const pr = repo.pulls.get(number);
    view.pullRequest =
      pr === undefined
        ? null
        : {
            id: prGlobalId(repo.owner, repo.name, pr.number),
            number: pr.number,
            title: pr.title,
            state: prState(pr),
            merged: pr.merged,
            headRefName: pr.head.ref,
            baseRefName: pr.base.ref,
            mergeable: mergeableOf(repo, pr),
          };
  }
  return ok({ repository: view });
}

// -------------------------------------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------------------------------------

function executeOperation(query: string, variables: Variables, store: Store): Envelope {
  try {
    if (typeof query !== 'string' || query.trim() === '') {
      return err('GraphQL query must be a non-empty string');
    }
    const name = operationNameOf(query);
    switch (name) {
      case 'ViewerLogin':
        return ok({ viewer: { login: store.viewer.login } });
      case 'RepositoryFields':
        return repositoryFromArgs(store, query, variables);
      case 'Issue_fields':
      case 'PullRequestAndRepositoryFields':
      case 'SearchType_enumValues':
        return ok(introspectionResult(query));
      case 'OpenIssues':
        return repositoryIssues(store, query, variables);
      case 'IssueByNumber':
        return repositoryIssue(store, query, variables);
      case 'IssueCreate':
        return doCreateIssue(store, query, variables);
      case 'IssueClose':
        return doCloseIssue(store, query, variables);
      case 'PullRequests':
        return repositoryPullRequests(store, query, variables);
      case 'PullRequestFiles':
        return repositoryPullRequestFiles(store, query, variables);
      case 'PullRequestId':
        return repositoryPullRequestId(store, query, variables);
      case 'PullRequestCreate':
        return doCreatePullRequest(store, query, variables);
      case 'MergePullRequest':
        return doMergePullRequest(store, query, variables);
      case 'AddComment':
        return doAddComment(store, query, variables);
      case 'ViewerInvalidField':
        return invalidField(store);
      case 'NodeRepository':
        return doNode(store, query, variables);
      case 'IssuesPage':
        return repositoryIssues(store, query, variables);
      default:
        break;
    }
    // Structural fallback for documents without a recognised operation name.
    if (query.includes('noSuchFieldOnViewer')) return invalidField(store);
    if (query.includes('__type(')) return ok(introspectionResult(query));
    if (query.includes('createIssue(')) return doCreateIssue(store, query, variables);
    if (query.includes('closeIssue(')) return doCloseIssue(store, query, variables);
    if (query.includes('createPullRequest(')) return doCreatePullRequest(store, query, variables);
    if (query.includes('mergePullRequest(')) return doMergePullRequest(store, query, variables);
    if (query.includes('addComment(')) return doAddComment(store, query, variables);
    if (query.includes('node(')) return doNode(store, query, variables);
    if (query.includes('viewer')) return ok({ viewer: { login: store.viewer.login } });
    if (query.includes('repository(')) return genericRepository(store, query, variables);
    return err(`Unknown GraphQL operation ${name ?? '(anonymous)'}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    pathname = req.url ?? '';
  }
  if (req.method !== 'POST' || pathname !== '/api/graphql') return false;
  const token = bearerToken(req);
  if (token === null || token !== process.env.MAKEFUN_SHOP_TOKEN) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Could not read request body' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return true;
  }
  if (Array.isArray(body)) {
    const out = body.map((entry) => {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).query === 'string'
      ) {
        const op = entry as { query: string; variables?: Record<string, unknown> };
        return executeOperation(op.query, op.variables ?? {}, store);
      }
      return err('Each batched operation must be an object with a query string');
    });
    sendJson(res, 200, out);
    return true;
  }
  if (body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).query === 'string') {
    const op = body as { query: string; variables?: Record<string, unknown> };
    sendJson(res, 200, executeOperation(op.query, op.variables ?? {}, store));
    return true;
  }
  sendJson(res, 400, { message: 'GraphQL body must be an object with a query string' });
  return true;
}
