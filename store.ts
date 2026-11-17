// store.ts — the in-memory forge store.
//
// One Store holds the seeded scenario (39 repositories, empty git histories)
// plus everything created at runtime. All ids are sequential counters, all
// timestamps are the fixed scenario epoch — nothing here reads a clock or a
// random source, so two runs over the same scenario stay identical.
//
// The git side of each repo starts empty: the conformance environment installs
// its own git fixture into repos, the store never invents history.

import { createHash } from 'node:crypto';
import { buildScenario, SCENARIO_EPOCH_ISO } from './scenario.ts';
import type { Scenario, ScenarioRepoSeed, ScenarioUser } from './scenario.ts';
import type { GitObject, GitObjectType, GitRepo } from './git.ts';

export type { ScenarioUser };

export class RepoExistsError extends Error {
  constructor(owner: string, name: string) {
    super(`repository ${owner}/${name} already exists`);
    this.name = 'RepoExistsError';
  }
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRecord {
  id: number;
  body: string;
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  git: GitRepo;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  labels: Map<string, LabelRecord>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

// An empty git repository: no objects, no refs. Object ids are the plain
// SHA-1 of `<type> <size>\0<body>`; ancestry walks commit parents read out
// of the stored commit headers.
function newEmptyGitRepo(): GitRepo {
  const objects = new Map<string, GitObject>();
  const refs = new Map<string, string>();
  const repo: GitRepo = {
    objects,
    refs,
    getObject(sha: string): GitObject | undefined {
      return objects.get(sha);
    },
    putObject(type: GitObjectType, body: Buffer): string {
      const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
      const sha = createHash('sha1').update(header).update(body).digest('hex');
      objects.set(sha, { type, body });
      return sha;
    },
    getRef(name: string): string | undefined {
      return refs.get(name);
    },
    setRef(name: string, sha: string): void {
      refs.set(name, sha);
    },
    deleteRef(name: string): boolean {
      return refs.delete(name);
    },
    isAncestor(ancestor: string, descendant: string): boolean {
      if (ancestor === descendant) return true;
      const seen = new Set<string>();
      const stack: string[] = [descendant];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') continue;
        const header = obj.body.toString('latin1').split('\n\n')[0] ?? '';
        for (const line of header.split('\n')) {
          if (!line.startsWith('parent ')) continue;
          const parent = line.slice('parent '.length).trim();
          if (parent === ancestor) return true;
          stack.push(parent);
        }
      }
      return false;
    },
  };
  return repo;
}

function seedToRecord(seed: ScenarioRepoSeed): RepoRecord {
  return {
    id: seed.id,
    name: seed.name,
    owner: seed.owner,
    fullName: seed.fullName,
    private: seed.private,
    description: seed.description,
    defaultBranch: seed.defaultBranch,
    createdAt: SCENARIO_EPOCH_ISO,
    updatedAt: SCENARIO_EPOCH_ISO,
    git: newEmptyGitRepo(),
    issues: new Map<number, IssueRecord>(),
    pulls: new Map<number, PullRecord>(),
    labels: new Map<string, LabelRecord>(),
    nextIssueNumber: 1,
    nextPullNumber: 1,
  };
}

export class Store {
  viewer: ScenarioUser;
  users: ScenarioUser[];
  stranger: ScenarioUser;
  org: string;
  repos: Map<string, RepoRecord>;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;

  constructor(scenario: Scenario) {
    this.viewer = scenario.viewer;
    this.users = scenario.users;
    this.stranger = scenario.stranger;
    this.org = scenario.org;
    this.repos = new Map<string, RepoRecord>();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
    this.nextPullId = 1;
    this.nextCommentId = 1;
    const seeds = [...scenario.viewerRepos, ...scenario.orgRepos, ...scenario.strangerRepos];
    for (const seed of seeds) {
      this.repos.set(`${seed.owner}/${seed.name}`, seedToRecord(seed));
      if (seed.id >= this.nextRepoId) this.nextRepoId = seed.id + 1;
    }
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(
    owner: string,
    name: string,
    opts: { private?: boolean; description?: string | null; autoInit?: boolean } = {},
  ): RepoRecord {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) throw new RepoExistsError(owner, name);
    // autoInit is accepted but never invents history: a new repo starts
    // empty, and its first commit arrives through the contents API or a push.
    const record: RepoRecord = {
      id: this.nextRepoId,
      name,
      owner,
      fullName: key,
      private: opts.private ?? false,
      description: opts.description ?? null,
      defaultBranch: 'main',
      createdAt: SCENARIO_EPOCH_ISO,
      updatedAt: SCENARIO_EPOCH_ISO,
      git: newEmptyGitRepo(),
      issues: new Map<number, IssueRecord>(),
      pulls: new Map<number, PullRecord>(),
      labels: new Map<string, LabelRecord>(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, record);
    return record;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  // Seeded repos first (scenario order), then created repos in creation
  // order — the map's insertion order already gives exactly that.
  listRepos(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }
}

export function createStore(): Store {
  return new Store(buildScenario());
}
