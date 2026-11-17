import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRecord, IssueRecord, PullRecord, CommentRecord } from './store.ts';
import type { GitRepo } from './git.ts';
import { bearerToken, jsonError, readBody, sendJson } from './http.ts';
import { parseCommit, parseTree, serializeCommit, serializeTree } from './git.ts';

const EPOCH_ISO = '2025-01-01T00:00:00Z';
const EPOCH_SEC = 1735689600;

type Body = Record<string, unknown>;
type ViewerIdentity = { name: string; email: string };

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseBody(raw: Buffer): Body | null {
  if (raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Body;
    }
    return {};
  } catch {
    return null;
  }
}

function identityLine(viewer: ViewerIdentity): string {
  return `${viewer.name} <${viewer.email}> ${EPOCH_SEC} +0000`;
}

function parseIdentity(line: string): { name: string; email: string } {
  const match = /^(.*) <([^<>]*)>/.exec(line);
  if (!match) return { name: line, email: '' };
  return { name: match[1], email: match[2] };
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

function repoJson(repo: RepoRecord, store: Store): Record<string, unknown> {
  const ownerUser = store.users.find((u) => u.login === repo.owner);
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: ownerUser ? ownerUser.id : repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
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
    user: { login: issue.user.login, id: issue.user.id },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function commentJson(comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? !isConflicted(repo, pull) : false;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    mergeable,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user.login, id: pull.user.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Git helpers (operate on the repo's git store)
// ---------------------------------------------------------------------------

function branchTip(git: GitRepo, branch: string): string | undefined {
  return git.getRef(`refs/heads/${branch}`);
}

function commitTreeSha(git: GitRepo, commitSha: string): string | undefined {
  const obj = git.getObject(commitSha);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.body).tree;
}

function readTreeEntries(
  git: GitRepo,
  treeSha: string | null,
): { mode: string; name: string; sha: string }[] {
  if (!treeSha) return [];
  const obj = git.getObject(treeSha);
  if (!obj) return [];
  return [...parseTree(obj.body)];
}

function flattenTree(
  git: GitRepo,
  treeSha: string,
  prefix: string,
  out: Map<string, { sha: string; mode: string }>,
): Map<string, { sha: string; mode: string }> {
  const obj = git.getObject(treeSha);
  if (!obj) return out;
  for (const entry of parseTree(obj.body)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(git, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

function treeFiles(git: GitRepo, commitSha: string): Map<string, { sha: string; mode: string }> {
  const treeSha = commitTreeSha(git, commitSha);
  if (!treeSha) return new Map();
  return flattenTree(git, treeSha, '', new Map());
}

function resolveDirTree(
  git: GitRepo,
  rootTreeSha: string,
  segments: string[],
): string | undefined {
  let current: string | undefined = rootTreeSha;
  for (const segment of segments) {
    if (!current) return undefined;
    const obj = git.getObject(current);
    if (!obj) return undefined;
    const entry = parseTree(obj.body).find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return current;
}

function dirEntries(
  git: GitRepo,
  treeSha: string,
  dirPath: string,
): Record<string, unknown>[] {
  const obj = git.getObject(treeSha);
  if (!obj) return [];
  return parseTree(obj.body).map((entry) => {
    const path = dirPath ? `${dirPath}/${entry.name}` : entry.name;
    const isDir = entry.mode === '40000';
    let size = 0;
    if (!isDir) {
      const blob = git.getObject(entry.sha);
      size = blob ? blob.body.length : 0;
    }
    return { type: isDir ? 'dir' : 'file', name: entry.name, path, sha: entry.sha, size };
  });
}

function blobText(git: GitRepo, sha: string | null): string {
  if (!sha) return '';
  const obj = git.getObject(sha);
  if (!obj) return '';
  return obj.body.toString('utf8');
}

function updateTree(
  git: GitRepo,
  treeSha: string | null,
  segments: string[],
  blobSha: string | null,
): string | null {
  const entries = readTreeEntries(git, treeSha);
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry = { mode: '100644', name: head, sha: blobSha };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  } else {
    const childSha = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].sha : null;
    const nextChild = updateTree(git, childSha, rest, blobSha);
    if (nextChild === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry = { mode: '40000', name: head, sha: nextChild };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  return git.putObject('tree', serializeTree(entries));
}

function emptyTreeSha(git: GitRepo): string {
  return git.putObject('tree', serializeTree([]));
}

function commitOnBranch(
  git: GitRepo,
  viewer: ViewerIdentity,
  branch: string,
  message: string,
  treeSha: string,
): string {
  const tip = branchTip(git, branch);
  const parents = tip ? [tip] : [];
  const line = identityLine(viewer);
  const body = serializeCommit({ tree: treeSha, parents, author: line, committer: line, message });
  const sha = git.putObject('commit', body);
  git.setRef(`refs/heads/${branch}`, sha);
  return sha;
}

// ---------------------------------------------------------------------------
// Line diff (for pull files)
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  const n = b.length;
  let prev = new Uint32Array(n + 1);
  let cur = new Uint32Array(n + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[n];
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4000000) return { additions: b.length, deletions: a.length };
  const common = lcsLength(a, b);
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------------------
// Pull-request diff and conflict detection
// ---------------------------------------------------------------------------

interface PathChange {
  path: string;
  baseSha: string | null;
  headSha: string | null;
}

function prChangedPaths(git: GitRepo, baseSha: string, headSha: string): PathChange[] {
  const baseFiles = treeFiles(git, baseSha);
  const headFiles = treeFiles(git, headSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const changed: PathChange[] = [];
  for (const path of paths) {
    const b = baseFiles.get(path)?.sha ?? null;
    const h = headFiles.get(path)?.sha ?? null;
    if (b !== h) changed.push({ path, baseSha: b, headSha: h });
  }
  return changed;
}

function resolveHeadSha(repo: RepoRecord, pull: PullRecord): string {
  return branchTip(repo.git, pull.head.ref) ?? pull.head.sha;
}

function isConflicted(repo: RepoRecord, pull: PullRecord): boolean {
  const git = repo.git;
  const currentBaseSha = branchTip(git, pull.base.ref);
  if (!currentBaseSha) return true;
  const currentBaseFiles = treeFiles(git, currentBaseSha);
  const headSha = resolveHeadSha(repo, pull);
  for (const change of prChangedPaths(git, pull.base.sha, headSha)) {
    const current = currentBaseFiles.get(change.path)?.sha ?? null;
    if (current !== change.baseSha && current !== change.headSha) return true;
  }
  return false;
}

function squashMerge(
  repo: RepoRecord,
  pull: PullRecord,
  viewer: ViewerIdentity,
): string | null {
  const git = repo.git;
  const baseSha = branchTip(git, pull.base.ref);
  if (!baseSha) return null;
  if (isConflicted(repo, pull)) return null;
  const baseTreeSha = commitTreeSha(git, baseSha);
  if (!baseTreeSha) return null;
  const headSha = resolveHeadSha(repo, pull);
  let treeSha: string | null = baseTreeSha;
  for (const change of prChangedPaths(git, pull.base.sha, headSha)) {
    treeSha = updateTree(git, treeSha, change.path.split('/'), change.headSha);
  }
  const finalTree = treeSha ?? emptyTreeSha(git);
  return commitOnBranch(git, viewer, pull.base.ref, pull.title, finalTree);
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pageUrl(req: IncomingMessage, pathname: string, params: Record<string, string>): string {
  const host = req.headers.host ?? '127.0.0.1';
  const qs = new URLSearchParams(params);
  return `http://${host}${pathname}?${qs.toString()}`;
}

function paginate<T>(
  all: T[],
  query: URLSearchParams,
  req: IncomingMessage,
  pathname: string,
): { items: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < all.length) {
    const params: Record<string, string> = {};
    query.forEach((value, key) => {
      if (key !== 'page' && key !== 'per_page') params[key] = value;
    });
    params.page = String(page + 1);
    params.per_page = String(perPage);
    link = `<${pageUrl(req, pathname, params)}>; rel="next"`;
  }
  return { items, link };
}

function sendPage(res: ServerResponse, items: unknown[], link: string | null): void {
  sendJson(res, 200, items, link ? { Link: link } : undefined);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  let pathname = rawUrl.split('?')[0];
  let query = new URLSearchParams();
  try {
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    pathname = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    // keep the fallbacks above
  }
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;

  try {
    const method = req.method ?? 'GET';
    let rawBody = Buffer.alloc(0);
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      rawBody = await readBody(req);
    }

    const expected = process.env.MAKEFUN_SHOP_TOKEN;
    const token = bearerToken(req);
    if (!expected || token !== expected) {
      jsonError(res, 401, 'Bad credentials');
      return true;
    }

    const viewer = store.viewer;
    const rest = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
    const segments = rest
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

    let parsedBody: Body | null | undefined;
    function getBody(): Body | null {
      if (parsedBody === undefined) parsedBody = parseBody(rawBody);
      return parsedBody;
    }

    // GET /api/v3/
    if (segments.length === 0) {
      if (method !== 'GET') {
        jsonError(res, 404, 'Not Found');
        return true;
      }
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'X-OAuth-Scopes': 'repo, read:org' },
      );
      return true;
    }

    // GET /api/v3/meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') {
        jsonError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }

    // GET /api/v3/user
    if (segments.length === 1 && segments[0] === 'user') {
      if (method !== 'GET') {
        jsonError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        login: viewer.login,
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        type: 'User',
      });
      return true;
    }

    // /api/v3/user/repos
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listRepos(viewer.login);
        const { items, link } = paginate(repos, query, req, pathname);
        sendPage(
          res,
          items.map((r) => repoJson(r, store)),
          link,
        );
        return true;
      }
      if (method === 'POST') {
        const body = getBody();
        if (body === null) {
          jsonError(res, 400, 'Invalid JSON');
          return true;
        }
        const name = str(body.name);
        if (!name) {
          jsonError(res, 422, 'Repository name is required');
          return true;
        }
        let repo: RepoRecord;
        try {
          repo = store.createRepo(viewer.login, name, {
            private: typeof body.private === 'boolean' ? body.private : false,
            description: str(body.description) ?? null,
            autoInit: typeof body.auto_init === 'boolean' ? body.auto_init : false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : '';
          const errName = (err as { name?: string } | null)?.name ?? '';
          if (errName === 'RepoExistsError' || /already exists/i.test(message)) {
            jsonError(res, 422, `Repository ${viewer.login}/${name} already exists`);
            return true;
          }
          throw err;
        }
        sendJson(res, 201, repoJson(repo, store));
        return true;
      }
      jsonError(res, 404, 'Not Found');
      return true;
    }

    // /api/v3/repos/{owner}/{name}[...]
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1];
      const repoName = segments[2];
      const tail = segments.slice(3);
      if (owner !== viewer.login) {
        jsonError(res, 404, 'Not Found');
        return true;
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        jsonError(res, 404, 'Repository not found');
        return true;
      }

      // Repo itself: GET / PATCH / DELETE
      if (tail.length === 0) {
        if (method === 'GET') {
          sendJson(res, 200, repoJson(repo, store));
          return true;
        }
        if (method === 'PATCH') {
          const body = getBody();
          if (body === null) {
            jsonError(res, 400, 'Invalid JSON');
            return true;
          }
          if ('description' in body) {
            repo.description =
              typeof body.description === 'string' ? body.description : null;
          }
          sendJson(res, 200, repoJson(repo, store));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(owner, repoName);
          sendJson(res, 204, null);
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // Branches
      if (tail[0] === 'branches') {
        if (method !== 'GET') {
          jsonError(res, 404, 'Not Found');
          return true;
        }
        if (tail.length === 1) {
          const out: Record<string, unknown>[] = [];
          for (const [ref, sha] of repo.git.refs) {
            if (ref.startsWith('refs/heads/')) {
              out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
            }
          }
          sendJson(res, 200, out);
          return true;
        }
        const branch = tail.slice(1).join('/');
        const sha = branchTip(repo.git, branch);
        if (!sha) {
          jsonError(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }

      // Commits
      if (tail[0] === 'commits') {
        if (method !== 'GET' || tail.length !== 1) {
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const branch = query.get('sha') ?? repo.defaultBranch;
        const tip = branchTip(repo.git, branch);
        const out: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        let current = tip;
        while (current && !seen.has(current)) {
          seen.add(current);
          const obj = repo.git.getObject(current);
          if (!obj || obj.type !== 'commit') break;
          const parsed = parseCommit(obj.body);
          out.push({
            sha: current,
            commit: {
              message: parsed.message.replace(/\n$/, ''),
              author: parseIdentity(parsed.author),
              committer: parseIdentity(parsed.committer),
            },
          });
          current = parsed.parents[0];
        }
        sendJson(res, 200, out);
        return true;
      }

      // Contents
      if (tail[0] === 'contents') {
        const contentPath = tail.slice(1).join('/');
        if (method === 'GET') {
          const refBranch = query.get('ref') ?? repo.defaultBranch;
          const tip = branchTip(repo.git, refBranch);
          if (!tip) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const treeSha = commitTreeSha(repo.git, tip);
          if (!treeSha) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          if (contentPath === '') {
            sendJson(res, 200, dirEntries(repo.git, treeSha, ''));
            return true;
          }
          const files = treeFiles(repo.git, tip);
          const file = files.get(contentPath);
          if (file) {
            const blob = repo.git.getObject(file.sha);
            const bytes = blob ? blob.body : Buffer.alloc(0);
            sendJson(res, 200, {
              type: 'file',
              name: contentPath.split('/').pop(),
              path: contentPath,
              sha: file.sha,
              size: bytes.length,
              encoding: 'base64',
              content: bytes.toString('base64'),
            });
            return true;
          }
          const dirTree = resolveDirTree(repo.git, treeSha, contentPath.split('/'));
          if (dirTree) {
            sendJson(res, 200, dirEntries(repo.git, dirTree, contentPath));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'PUT') {
          const body = getBody();
          if (body === null) {
            jsonError(res, 400, 'Invalid JSON');
            return true;
          }
          const message = str(body.message);
          const content = str(body.content);
          if (!contentPath) {
            jsonError(res, 422, 'path is required');
            return true;
          }
          if (!message || content === undefined) {
            jsonError(res, 422, 'message and content are required');
            return true;
          }
          const branch = str(body.branch) ?? repo.defaultBranch;
          const tip = branchTip(repo.git, branch);
          const files = tip ? treeFiles(repo.git, tip) : new Map();
          const existing = files.get(contentPath);
          if (!existing && tip) {
            const baseTree = commitTreeSha(repo.git, tip);
            if (baseTree && resolveDirTree(repo.git, baseTree, contentPath.split('/'))) {
              jsonError(res, 422, 'path is a directory');
              return true;
            }
          }
          const givenSha = str(body.sha);
          if (existing && givenSha && givenSha !== existing.sha) {
            jsonError(res, 409, 'sha does not match the current file');
            return true;
          }
          const contentBuf = Buffer.from(content, 'base64');
          const blobSha = repo.git.putObject('blob', contentBuf);
          const baseTree = tip ? commitTreeSha(repo.git, tip) ?? null : null;
          const newTree = updateTree(repo.git, baseTree, contentPath.split('/'), blobSha);
          const finalTree = newTree ?? emptyTreeSha(repo.git);
          const commitSha = commitOnBranch(repo.git, viewer, branch, message, finalTree);
          sendJson(res, existing ? 200 : 201, {
            content: {
              name: contentPath.split('/').pop(),
              path: contentPath,
              sha: blobSha,
              size: contentBuf.length,
              type: 'file',
              encoding: 'base64',
            },
            commit: { sha: commitSha },
          });
          return true;
        }
        if (method === 'DELETE') {
          const body = getBody();
          if (body === null) {
            jsonError(res, 400, 'Invalid JSON');
            return true;
          }
          const message = str(body.message);
          if (!message) {
            jsonError(res, 422, 'message is required');
            return true;
          }
          const branch = str(body.branch) ?? repo.defaultBranch;
          const tip = branchTip(repo.git, branch);
          if (!tip) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const files = treeFiles(repo.git, tip);
          const existing = files.get(contentPath);
          if (!existing) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const givenSha = str(body.sha);
          if (givenSha && givenSha !== existing.sha) {
            jsonError(res, 409, 'sha does not match the current file');
            return true;
          }
          const baseTree = commitTreeSha(repo.git, tip) ?? null;
          const newTree = updateTree(repo.git, baseTree, contentPath.split('/'), null);
          const finalTree = newTree ?? emptyTreeSha(repo.git);
          const commitSha = commitOnBranch(repo.git, viewer, branch, message, finalTree);
          sendJson(res, 200, { commit: { sha: commitSha } });
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // Labels
      if (tail[0] === 'labels') {
        if (method !== 'POST' || tail.length !== 1) {
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const body = getBody();
        if (body === null) {
          jsonError(res, 400, 'Invalid JSON');
          return true;
        }
        const name = str(body.name);
        if (!name) {
          jsonError(res, 422, 'Label name is required');
          return true;
        }
        const existingLabel = repo.labels.get(name);
        if (existingLabel) {
          sendJson(res, 201, {
            id: existingLabel.id,
            name: existingLabel.name,
            color: existingLabel.color,
            description: existingLabel.description,
          });
          return true;
        }
        const label = {
          id: repo.labels.size + 1,
          name,
          color: str(body.color) ?? 'ededed',
          description: str(body.description) ?? null,
        };
        repo.labels.set(name, label);
        sendJson(res, 201, {
          id: label.id,
          name: label.name,
          color: label.color,
          description: label.description,
        });
        return true;
      }

      // Git refs
      if (tail[0] === 'git' && tail[1] === 'refs') {
        if (method === 'POST' && tail.length === 2) {
          const body = getBody();
          if (body === null) {
            jsonError(res, 400, 'Invalid JSON');
            return true;
          }
          const ref = str(body.ref);
          const sha = str(body.sha);
          if (!ref || !sha) {
            jsonError(res, 422, 'ref and sha are required');
            return true;
          }
          repo.git.setRef(ref, sha);
          sendJson(res, 201, { ref, object: { sha } });
          return true;
        }
        if (method === 'GET' && tail.length > 2) {
          const refName = `refs/${tail.slice(2).join('/')}`;
          const sha = repo.git.getRef(refName);
          if (!sha) {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, { ref: refName, object: { sha } });
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // Issues
      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = query.get('state') ?? 'open';
            const direction = query.get('direction') ?? 'desc';
            let list = [...repo.issues.values()];
            if (state === 'open') list = list.filter((i) => i.state === 'open');
            else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
            else if (state !== 'all') list = list.filter((i) => i.state === 'open');
            list.sort((a, b) =>
              direction === 'asc' ? a.number - b.number : b.number - a.number,
            );
            const { items, link } = paginate(list, query, req, pathname);
            sendPage(
              res,
              items.map((i) => issueJson(i)),
              link,
            );
            return true;
          }
          if (method === 'POST') {
            const body = getBody();
            if (body === null) {
              jsonError(res, 400, 'Invalid JSON');
              return true;
            }
            const title = str(body.title);
            if (!title) {
              jsonError(res, 422, 'title is required');
              return true;
            }
            const labelNames: string[] = Array.isArray(body.labels)
              ? body.labels.filter((l): l is string => typeof l === 'string')
              : [];
            for (const labelName of labelNames) {
              if (!repo.labels.has(labelName)) {
                jsonError(res, 422, `Label '${labelName}' does not exist`);
                return true;
              }
            }
            const number = repo.nextIssueNumber;
            repo.nextIssueNumber += 1;
            const issue: IssueRecord = {
              id: store.nextIssueId,
              number,
              title,
              body: str(body.body) ?? null,
              state: 'open',
              labels: labelNames,
              user: viewer,
              createdAt: EPOCH_ISO,
              updatedAt: EPOCH_ISO,
              closedAt: null,
              comments: [],
            };
            store.nextIssueId += 1;
            repo.issues.set(number, issue);
            sendJson(res, 201, issueJson(issue));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const numRaw = tail[1];
        if (!/^\d+$/.test(numRaw)) {
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const number = Number.parseInt(numRaw, 10);
        const issue = repo.issues.get(number);
        if (tail.length === 2) {
          if (!issue) {
            jsonError(res, 404, 'Issue not found');
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issueJson(issue));
            return true;
          }
          if (method === 'PATCH') {
            const body = getBody();
            if (body === null) {
              jsonError(res, 400, 'Invalid JSON');
              return true;
            }
            const state = str(body.state);
            if (state !== undefined && state !== 'open' && state !== 'closed') {
              jsonError(res, 422, 'state must be open or closed');
              return true;
            }
            if (state !== undefined) {
              issue.state = state;
              issue.closedAt = state === 'closed' ? EPOCH_ISO : null;
            }
            const title = str(body.title);
            if (title !== undefined) issue.title = title;
            const bodyText = str(body.body);
            if (bodyText !== undefined) issue.body = bodyText;
            sendJson(res, 200, issueJson(issue));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (!issue) {
            jsonError(res, 404, 'Issue not found');
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => commentJson(c)));
            return true;
          }
          if (method === 'POST') {
            const body = getBody();
            if (body === null) {
              jsonError(res, 400, 'Invalid JSON');
              return true;
            }
            const text = str(body.body) ?? '';
            const comment: CommentRecord = {
              id: store.nextCommentId,
              body: text,
              user: viewer,
              createdAt: EPOCH_ISO,
              updatedAt: EPOCH_ISO,
            };
            store.nextCommentId += 1;
            issue.comments.push(comment);
            sendJson(res, 201, commentJson(comment));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // Pulls
      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = query.get('state') ?? 'open';
            let list = [...repo.pulls.values()];
            if (state === 'open') list = list.filter((p) => p.state === 'open');
            else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
            else if (state !== 'all') list = list.filter((p) => p.state === 'open');
            list.sort((a, b) => b.number - a.number);
            const { items, link } = paginate(list, query, req, pathname);
            sendPage(
              res,
              items.map((p) => pullJson(repo, p)),
              link,
            );
            return true;
          }
          if (method === 'POST') {
            const body = getBody();
            if (body === null) {
              jsonError(res, 400, 'Invalid JSON');
              return true;
            }
            const title = str(body.title);
            const head = str(body.head);
            const base = str(body.base);
            if (!title || !head || !base) {
              jsonError(res, 422, 'title, head and base are required');
              return true;
            }
            const headSha = branchTip(repo.git, head);
            const baseSha = branchTip(repo.git, base);
            if (!headSha || !baseSha) {
              jsonError(res, 422, 'head or base branch not found');
              return true;
            }
            for (const existing of repo.pulls.values()) {
              if (existing.state === 'open' && existing.head.ref === head) {
                jsonError(res, 422, 'A pull request already exists for this head branch');
                return true;
              }
            }
            const number = repo.nextPullNumber;
            repo.nextPullNumber += 1;
            const pull: PullRecord = {
              id: store.nextPullId,
              number,
              title,
              body: str(body.body) ?? null,
              state: 'open',
              merged: false,
              mergeable: true,
              head: { ref: head, sha: headSha },
              base: { ref: base, sha: baseSha },
              mergedAt: null,
              mergeCommitSha: null,
              user: viewer,
              createdAt: EPOCH_ISO,
              updatedAt: EPOCH_ISO,
            };
            store.nextPullId += 1;
            repo.pulls.set(number, pull);
            sendJson(res, 201, pullJson(repo, pull));
            return true;
          }
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const numRaw = tail[1];
        if (!/^\d+$/.test(numRaw)) {
          jsonError(res, 404, 'Not Found');
          return true;
        }
        const number = Number.parseInt(numRaw, 10);
        const pull = repo.pulls.get(number);
        if (tail.length === 2) {
          if (!pull) {
            jsonError(res, 404, 'Pull request not found');
            return true;
          }
          if (method !== 'GET') {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'files') {
          if (!pull) {
            jsonError(res, 404, 'Pull request not found');
            return true;
          }
          if (method !== 'GET') {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const headSha = resolveHeadSha(repo, pull);
          const files = prChangedPaths(repo.git, pull.base.sha, headSha).map((change) => {
            const oldText = blobText(repo.git, change.baseSha);
            const newText = blobText(repo.git, change.headSha);
            const counts = lineDiff(oldText, newText);
            const status =
              change.baseSha === null ? 'added' : change.headSha === null ? 'removed' : 'modified';
            return {
              filename: change.path,
              status,
              additions: counts.additions,
              deletions: counts.deletions,
              changes: counts.additions + counts.deletions,
            };
          });
          sendJson(res, 200, files);
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge') {
          if (!pull) {
            jsonError(res, 404, 'Pull request not found');
            return true;
          }
          if (method !== 'PUT') {
            jsonError(res, 404, 'Not Found');
            return true;
          }
          const body = getBody();
          if (body === null) {
            jsonError(res, 400, 'Invalid JSON');
            return true;
          }
          if (pull.merged || pull.state !== 'open') {
            jsonError(res, 405, 'Pull request is already merged or closed');
            return true;
          }
          const sha = squashMerge(repo, pull, viewer);
          if (sha === null) {
            jsonError(res, 405, 'Merge conflict: the pull request cannot be merged cleanly');
            return true;
          }
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = EPOCH_ISO;
          pull.mergeCommitSha = sha;
          sendJson(res, 200, { merged: true, sha, message: pull.title });
          return true;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      jsonError(res, 404, 'Not Found');
      return true;
    }

    jsonError(res, 404, 'Not Found');
    return true;
  } catch (err) {
    if (!res.writableEnded) {
      jsonError(res, 500, err instanceof Error ? err.message : 'Internal error');
    }
    return true;
  }
}
