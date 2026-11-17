// mcp.ts — the Model Context Protocol surface (SPEC §3.7, §7).
//
// JSON-RPC 2.0 over Streamable HTTP at POST /mcp, answered as
// application/json. Two eras are spoken: the modern 2026-07-28 era
// (server/discover, no handshake, no session) and the legacy handshake era
// (initialize + notifications/initialized, 2025-11-25 and earlier). Every
// tool works on the same store the REST, GraphQL and git surfaces use, so an
// object created over MCP reads back over REST with the same id.
//
// Determinism: no wall clock, no randomness anywhere here. Ids are
// sequential, timestamps are the fixed scenario epoch, and the tools list is
// one module-level constant, so two tools/list calls answer byte-identical
// bodies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitRepo } from './git.ts';
import type { IssueRecord, PullRecord, RepoRecord, Store } from './store.ts';
import { parseCommit, parseTree, serializeCommit, serializeTree } from './git.ts';
import { bearerToken, readBody, sendJson } from './http.ts';

type JsonRpcId = string | number | null;
type Args = Record<string, unknown>;

const EPOCH_ISO = '2025-01-01T00:00:00Z';
const EPOCH_SEC = 1735689600;
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '0.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_REVISIONS = [MODERN_REVISION, ...LEGACY_REVISIONS];
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';

// ---------------------------------------------------------------------------
// Small helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool failure: answered as a tool result with isError true, never HTTP 500. */
class ToolProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolProblem';
  }
}

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, status: number, id: JsonRpcId, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

/** The bearer token matches the entry's own env token, exactly. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  const presented = bearerToken(req);
  return presented !== null && presented === expected;
}

// ---------------------------------------------------------------------------
// Tool definitions: one constant, built once, so tools/list repeats byte for
// byte. Required lists stay minimal — only arguments the suite fills.

interface ToolSchemaProperty {
  type: string;
  description: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
  };
}

function str(description: string): ToolSchemaProperty {
  return { type: 'string', description };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        name: str('Name of the repository to create.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        repo: str('Name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        repo: str('Name of the repository.'),
        title: str('Title of the issue.'),
        body: str('Body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        repo: str('Name of the repository.'),
        state: str('Issue state to list: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        repo: str('Name of the repository.'),
        title: str('Title of the pull request.'),
        body: str('Body of the pull request.'),
        head: str('Name of the head branch.'),
        base: str('Name of the base branch.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Login of the repository owner.'),
        repo: str('Name of the repository.'),
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

// ---------------------------------------------------------------------------
// Argument resolution: accept the canonical names, the documented synonyms,
// and a full_name of "owner/repo" as a fallback for owner+repo.

const OWNER_KEYS = ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const TITLE_KEYS = ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'];
const BODY_KEYS = ['body', 'issue_body', 'description', 'content', 'text', 'comment'];
const HEAD_KEYS = ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'];
const BASE_KEYS = ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'];
const NUMBER_KEYS = ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'];

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function pickString(args: Args, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(args[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickNumber(args: Args, keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function splitFullName(args: Args): { owner: string; repo: string } | null {
  const full = asString(args['full_name']) ?? asString(args['fullName']);
  if (full === null) return null;
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) return null;
  return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
}

function resolveOwnerRepo(args: Args): { owner: string; repo: string } | null {
  const owner = pickString(args, OWNER_KEYS);
  const repo = pickString(args, REPO_KEYS);
  if (owner !== null && repo !== null) return { owner, repo };
  return splitFullName(args);
}

function normalizeRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// ---------------------------------------------------------------------------
// Result shapes (the same records REST serves, so ids are stable across reads)

function repoJson(record: RepoRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    full_name: record.fullName,
    owner: { login: record.owner },
    private: record.private,
    description: record.description,
    default_branch: record.defaultBranch,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function issueJson(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user.login },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullJson(pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user.login },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function toolOk(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Git helpers for the squash merge (SPEC §3.4): flatten a tree, diff two
// trees, and rebuild nested trees bottom-up from a flat path map.

type FlatEntry = { mode: string; sha: string };

function flattenTree(git: GitRepo, rootSha: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (treeSha: string, prefix: string): void => {
    const obj = git.getObject(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.sha, path);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  };
  walk(rootSha, '');
  return out;
}

function buildTreeFromFlat(git: GitRepo, flat: Map<string, FlatEntry>): string {
  interface Dir {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i]!;
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, entry);
  }
  const writeDir = (dir: Dir): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: writeDir(sub) });
    return git.putObject('tree', serializeTree(entries));
  };
  return writeDir(root);
}

function commitTreeSha(git: GitRepo, commitSha: string): string | null {
  const obj = git.getObject(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.body).tree;
}

function commitParents(git: GitRepo, commitSha: string): string[] {
  const obj = git.getObject(commitSha);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.body).parents;
}

/** The nearest commit reachable from both tips (breadth-first from b). */
function mergeBase(git: GitRepo, a: string, b: string): string | null {
  const aAncestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (aAncestors.has(sha)) continue;
    aAncestors.add(sha);
    for (const parent of commitParents(git, sha)) stack.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (aAncestors.has(sha)) return sha;
    for (const parent of commitParents(git, sha)) queue.push(parent);
  }
  return null;
}

/** Paths whose blob differs between two flat trees; null marks a deletion. */
function diffTrees(before: Map<string, FlatEntry>, after: Map<string, FlatEntry>): Map<string, FlatEntry | null> {
  const out = new Map<string, FlatEntry | null>();
  for (const [path, entry] of after) {
    const prev = before.get(path);
    if (prev === undefined || prev.sha !== entry.sha || prev.mode !== entry.mode) out.set(path, entry);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) out.set(path, null);
  }
  return out;
}

/**
 * The squash merge (SPEC §3.4): one commit on the base branch whose tree is
 * the base tree with the pull request's changed files applied, then the pull
 * request is closed and marked merged. A path changed on both sides with
 * different content after the merge base is a real conflict.
 */
function squashMerge(record: RepoRecord, pull: PullRecord): string {
  const git = record.git;
  const headSha = pull.head.sha;
  const baseRefName = `refs/heads/${pull.base.ref}`;
  const baseTip = git.getRef(baseRefName);
  if (baseTip === undefined) throw new ToolProblem(`base branch not found: ${pull.base.ref}`);
  const baseTreeSha = commitTreeSha(git, baseTip);
  const headTreeSha = commitTreeSha(git, headSha);
  if (baseTreeSha === null) throw new ToolProblem('cannot read the base branch tip commit');
  if (headTreeSha === null) throw new ToolProblem('cannot read the head branch tip commit');
  const base = mergeBase(git, headSha, baseTip);
  const baseTree = base === null ? new Map<string, FlatEntry>() : flattenTree(git, commitTreeSha(git, base) ?? '');
  const headChanges = diffTrees(baseTree, flattenTree(git, headTreeSha));
  const baseChanges = diffTrees(baseTree, flattenTree(git, baseTreeSha));
  for (const [path, headEntry] of headChanges) {
    if (!baseChanges.has(path)) continue;
    const baseEntry = baseChanges.get(path)!;
    const headValue = headEntry === null ? null : headEntry.sha;
    const baseValue = baseEntry === null ? null : baseEntry.sha;
    if (headValue !== baseValue) throw new ToolProblem(`merge conflict: ${path} changed on both sides with different content`);
  }
  const merged = flattenTree(git, baseTreeSha);
  for (const [path, entry] of headChanges) {
    if (entry === null) merged.delete(path);
    else merged.set(path, entry);
  }
  const treeSha = buildTreeFromFlat(git, merged);
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`;
  const mergeSha = git.putObject(
    'commit',
    serializeCommit({ tree: treeSha, parents: [baseTip], author: identity, committer: identity, message }),
  );
  git.setRef(baseRefName, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = EPOCH_ISO;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = EPOCH_ISO;
  return mergeSha;
}

// ---------------------------------------------------------------------------
// The six tools

function requireRepo(store: Store, args: Args): RepoRecord {
  const target = resolveOwnerRepo(args);
  if (target === null) throw new ToolProblem('owner and repo are required');
  const record = store.getRepo(target.owner, target.repo);
  if (record === undefined) throw new ToolProblem(`repository not found: ${target.owner}/${target.repo}`);
  return record;
}

function runTool(store: Store, name: string, args: Args): Record<string, unknown> {
  const canonical = TOOL_ALIASES[name] ?? name;
  switch (canonical) {
    case 'create_repo': {
      const owner = pickString(args, OWNER_KEYS) ?? splitFullName(args)?.owner ?? store.viewer.login;
      const repoName = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) ?? splitFullName(args)?.repo ?? null;
      if (repoName === null) throw new ToolProblem('create_repo requires a name');
      const description = pickString(args, ['description', 'about', 'summary']) ?? null;
      const isPrivate = args['private'] === true || args['is_private'] === true;
      let record: RepoRecord;
      try {
        record = store.createRepo(owner, repoName, { private: isPrivate, description, autoInit: false });
      } catch (err) {
        throw new ToolProblem(err instanceof Error ? err.message : 'repository already exists');
      }
      return toolOk(repoJson(record));
    }
    case 'get_repo': {
      return toolOk(repoJson(requireRepo(store, args)));
    }
    case 'create_issue': {
      const record = requireRepo(store, args);
      const title = pickString(args, TITLE_KEYS);
      if (title === null) throw new ToolProblem('create_issue requires a title');
      const body = pickString(args, BODY_KEYS) ?? '';
      const issue: IssueRecord = {
        id: store.nextIssueId,
        number: record.nextIssueNumber,
        title,
        body,
        state: 'open',
        labels: [],
        user: store.viewer,
        createdAt: EPOCH_ISO,
        updatedAt: EPOCH_ISO,
        closedAt: null,
        comments: [],
      };
      store.nextIssueId += 1;
      record.nextIssueNumber += 1;
      record.issues.set(issue.number, issue);
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const record = requireRepo(store, args);
      const state = pickString(args, ['state', 'status']);
      let list = [...record.issues.values()];
      if (state !== null) {
        const wanted = state.toLowerCase();
        if (wanted === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (wanted === 'closed') list = list.filter((issue) => issue.state === 'closed');
      }
      return toolOk({ issues: list.map((issue) => issueJson(issue)), total_count: list.length });
    }
    case 'create_pull_request': {
      const record = requireRepo(store, args);
      const title = pickString(args, TITLE_KEYS);
      const head = pickString(args, HEAD_KEYS);
      const base = pickString(args, BASE_KEYS);
      if (title === null) throw new ToolProblem('create_pull_request requires a title');
      if (head === null) throw new ToolProblem('create_pull_request requires a head branch');
      if (base === null) throw new ToolProblem('create_pull_request requires a base branch');
      const headRef = normalizeRef(head);
      const baseRef = normalizeRef(base);
      const headSha = record.git.getRef(`refs/heads/${headRef}`);
      const baseSha = record.git.getRef(`refs/heads/${baseRef}`);
      if (headSha === undefined) throw new ToolProblem(`head branch not found: ${headRef}`);
      if (baseSha === undefined) throw new ToolProblem(`base branch not found: ${baseRef}`);
      const body = pickString(args, BODY_KEYS) ?? '';
      const pull: PullRecord = {
        id: store.nextPullId,
        number: record.nextPullNumber,
        title,
        body,
        state: 'open',
        merged: false,
        mergeable: true,
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        mergedAt: null,
        mergeCommitSha: null,
        user: store.viewer,
        createdAt: EPOCH_ISO,
        updatedAt: EPOCH_ISO,
      };
      store.nextPullId += 1;
      record.nextPullNumber += 1;
      record.pulls.set(pull.number, pull);
      return toolOk(pullJson(pull));
    }
    case 'merge_pull_request': {
      const record = requireRepo(store, args);
      const number = pickNumber(args, NUMBER_KEYS);
      if (number === null) throw new ToolProblem('merge_pull_request requires a pull_number');
      const pull = record.pulls.get(number);
      if (pull === undefined) throw new ToolProblem(`pull request not found: ${number}`);
      if (pull.merged) throw new ToolProblem(`pull request #${number} is already merged`);
      const mergeSha = squashMerge(record, pull);
      return toolOk({ merged: true, sha: mergeSha, message: `Pull request #${number} merged`, number, pull_number: number, state: 'closed' });
    }
    default:
      throw new ToolProblem(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// The endpoint

/** Handle POST /mcp; true when this request was an MCP request. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (req.method !== 'POST' || pathname !== '/mcp') return false;

  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error: request body is not valid JSON');
    return true;
  }
  if (!isRecord(payload)) {
    rpcError(res, 400, null, -32600, 'Invalid Request: expected a JSON-RPC object');
    return true;
  }
  const hasId = 'id' in payload && payload.id !== undefined;
  const id: JsonRpcId = hasId ? (payload.id as JsonRpcId) : null;

  // Auth is decided before any tool dispatch, for every method.
  if (!authorized(req)) {
    rpcError(res, 401, id, -32600, 'Unauthorized: a valid bearer token is required');
    return true;
  }

  const method = typeof payload.method === 'string' ? payload.method : '';
  if (method.startsWith('notifications/') || !hasId) {
    // A notification carries no id and gets no JSON-RPC reply.
    res.writeHead(202);
    res.end();
    return true;
  }

  const params = isRecord(payload.params) ? payload.params : {};
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  switch (method) {
    case 'server/discover': {
      rpcResult(res, id, {
        supportedVersions: [...SUPPORTED_REVISIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const chosen = offered !== '' && SUPPORTED_REVISIONS.includes(offered) ? offered : '2025-11-25';
      rpcResult(res, id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo });
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params['name'] === 'string' ? params['name'] : '';
      const args = isRecord(params['arguments']) ? params['arguments'] : {};
      if (toolName === '') {
        rpcError(res, 200, id, -32602, 'Invalid params: tools/call requires a tool name');
        return true;
      }
      if (TOOL_ALIASES[toolName] === undefined && !TOOLS.some((tool) => tool.name === toolName)) {
        rpcError(res, 200, id, -32601, `Method not found: unknown tool ${toolName}`);
        return true;
      }
      try {
        rpcResult(res, id, runTool(store, toolName, args));
      } catch (err) {
        if (err instanceof ToolProblem) rpcResult(res, id, toolErr(err.message));
        else rpcResult(res, id, toolErr(err instanceof Error ? err.message : 'tool failed'));
      }
      return true;
    }
    default: {
      rpcError(res, 200, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}
