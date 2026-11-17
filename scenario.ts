// scenario.ts — the one seeded dataset for github-core-clone-01.
//
// Every user, repo, path, blob, commit message and issue/PR title derives from
// the single fixed seed below. The streams are pure: the same label always
// yields the same bytes, so a live run, a replay and a local practice run all
// see byte-identical data. No clocks, no randomness anywhere in this file.

export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
export const SCENARIO_EPOCH_ISO = '2025-01-01T00:00:00Z';
export const SCENARIO_EPOCH_SEC = 1735689600;

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const MASK_64 = 0xffffffffffffffffn;
const DAY_SECONDS = 86400;
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface ScenarioRepoSeed {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}

export interface ScenarioBlob {
  path: string;
  content: string;
  base64: string;
}

export interface ScenarioCommitTemplate {
  message: string;
  author: ScenarioUser;
  epochSec: number;
  iso: string;
}

export interface ScenarioIssueTemplate {
  title: string;
  body: string;
  labels: string[];
}

export interface ScenarioPullTemplate {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface Scenario {
  seed: string;
  viewer: ScenarioUser;
  teammate: ScenarioUser;
  stranger: ScenarioUser;
  users: ScenarioUser[];
  org: string;
  viewerRepos: ScenarioRepoSeed[];
  orgRepos: ScenarioRepoSeed[];
  strangerRepos: ScenarioRepoSeed[];
  labels: string[];
  branches: string[];
  filePaths: string[];
  blobs: ScenarioBlob[];
  commitTemplates: ScenarioCommitTemplate[];
  issueTemplates: ScenarioIssueTemplate[];
  pullTemplates: ScenarioPullTemplate[];
}

// ---------------------------------------------------------------- word lists

const GIVEN_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const FAMILY_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];

const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

const REPO_DESCRIPTIONS: readonly string[] = [
  'a small service with a sharp edge',
  'notes and experiments, kept until they are not',
  'the tooling behind the thing',
  'a reference implementation, for reading',
  'what the prototype became',
  'fixtures, generators and the odd benchmark',
  'the parts that must not break',
  'a sandbox for the next idea',
];

const PATH_SEGMENTS: readonly string[] = [
  'src', 'lib', 'docs', 'test', 'scripts', 'api', 'core', 'util', 'config', 'data', 'web', 'cli', 'pkg',
  'internal', 'examples', 'assets', 'build', 'tools', 'server', 'client',
];

const FILE_STEMS: readonly string[] = [
  'index', 'request', 'response', 'server', 'client', 'schema', 'parser', 'router', 'config', 'store',
  'clock', 'queue', 'render', 'format', 'validate', 'session', 'token', 'event', 'stream', 'cache',
];

const FILE_EXTENSIONS: readonly string[] = ['ts', 'js', 'json', 'md', 'txt', 'yml', 'toml', 'css', 'html', 'sql'];

const BLOB_WORDS: readonly string[] = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor',
  'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'drift', 'ember', 'frost', 'granite',
  'hollow', 'ivory', 'jasper', 'kelp', 'lichen', 'moss', 'nickel',
];

const COMMIT_VERBS: readonly string[] = [
  'Add', 'Fix', 'Refactor', 'Document', 'Test', 'Tidy', 'Speed up', 'Simplify', 'Handle', 'Extract',
  'Inline', 'Rename', 'Guard', 'Wire', 'Drop',
];

const COMMIT_OBJECTS: readonly string[] = [
  'the request parser', 'repo lookup', 'issue pagination', 'the merge path', 'token checks',
  'the clone endpoint', 'packfile handling', 'error bodies', 'branch listing', 'the GraphQL node query',
  'MCP tool dispatch', 'rate limit headers', 'the upload pack', 'the ref advertisement', 'commit ancestry',
];

const ISSUE_ADJECTIVES: readonly string[] = [
  'Broken', 'Slow', 'Missing', 'Confusing', 'Unexpected', 'Flaky', 'Incorrect', 'Unclear', 'Stale', 'Noisy',
];

const ISSUE_SUBJECTS: readonly string[] = [
  'clone over HTTP', 'push report-status', 'issue pagination', 'merge button', 'GraphQL node ids',
  'MCP tool list', 'shallow fetch', 'tag listing', 'repo creation', 'content update', 'branch deletion',
  'commit listing',
];

const PULL_VERBS: readonly string[] = ['Add', 'Fix', 'Improve', 'Simplify', 'Document', 'Refactor', 'Speed up', 'Harden'];

const PULL_SUBJECTS: readonly string[] = [
  'shallow fetch support', 'push report status checks', 'issue label validation', 'merge conflict detection',
  'GraphQL cursor pagination', 'MCP tool schemas', 'packfile delta reuse', 'conditional requests',
  'repo pagination', 'branch protection stubs',
];

const SENTENCE_STARTS: readonly string[] = [
  'Steps to reproduce are below', 'This showed up after the last change', 'The expected behaviour is clear',
  'A minimal case is attached', 'It works on a fresh repository', 'The same flow works over the API',
];

const SENTENCE_ENDS: readonly string[] = [
  'and the server answers with a JSON error', 'but the second request fails', 'and nothing is written to the log',
  'while the reply body stays empty', 'and the status is wrong for the method', 'so the client gives up',
];

const ISSUE_LABELS: readonly string[] = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];

const DEFAULT_BRANCHES: readonly string[] = ['main', 'develop', 'release/1.0'];

const BRANCH_KINDS: readonly string[] = ['feature', 'fix', 'perf', 'docs', 'chore'];

// ---------------------------------------------------------------- the PRNG

// FNV-1a over a label's UTF-16 code units, kept to 64 bits.
function hashLabel(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash;
}

// splitmix64's finalizer: spreads one input bit pattern across all 64 bits.
function mixSeed(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK_64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return (z ^ (z >> 31n)) & MASK_64;
}

// The start state of the stream named `label`: seed x label-hash, mixed.
function streamSeed(label: string): bigint {
  return mixSeed(SCENARIO_SEED ^ hashLabel(label));
}

// xorshift64* generator. State is a single 64-bit word advanced by three
// shifts and one multiply; every draw comes from this word and nothing else.
export class DeterministicRng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK_64;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): DeterministicRng {
    return new DeterministicRng(streamSeed(label));
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK_64;
    x = (x ^ (x << 25n)) & MASK_64;
    x = (x ^ (x >> 27n)) & MASK_64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK_64;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  // Uniform integer in [0, maxExclusive); rejection keeps it unbiased.
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)] as T;
  }

  // Fisher-Yates over a copy; draws happen from the end of the list backwards.
  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const held = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = held;
    }
    return copy;
  }
}

// A named stream: same label, same numbers, in any process and any order.
function streamRng(label: string): DeterministicRng {
  return DeterministicRng.fromLabel(label);
}

// ---------------------------------------------------------------- timestamps

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// ISO-8601 UTC string for an epoch second, computed with pure integer
// calendar arithmetic (days -> civil date) so no wall clock is ever read.
function isoFromEpochSec(epochSec: number): string {
  const days = Math.floor(epochSec / DAY_SECONDS);
  const rest = epochSec - days * DAY_SECONDS;
  const hour = Math.floor(rest / 3600);
  const minute = Math.floor((rest - hour * 3600) / 60);
  const second = rest - hour * 3600 - minute * 60;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = month <= 2 ? y + 1 : y;
  return `${year}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(second)}.000Z`;
}

// ---------------------------------------------------------------- generators

function makeUsers(rng: DeterministicRng, count: number): ScenarioUser[] {
  const taken = new Set<string>();
  const users: ScenarioUser[] = [];
  const total = Math.max(0, Math.trunc(count));
  for (let i = 0; i < total; i += 1) {
    const first = rng.pick(GIVEN_NAMES);
    const last = rng.pick(FAMILY_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (taken.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

function makeRepos(rng: DeterministicRng, owner: string, count: number, firstId = 5000): ScenarioRepoSeed[] {
  const taken = new Set<string>();
  const repos: ScenarioRepoSeed[] = [];
  const total = Math.max(0, Math.trunc(count));
  for (let i = 0; i < total; i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(name);
    repos.push({
      id: firstId + i,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: rng.pick(REPO_DESCRIPTIONS),
      private: i % 7 === 3,
      defaultBranch: 'main',
    });
  }
  return repos;
}

function makeFilePaths(rng: DeterministicRng, count: number): string[] {
  const taken = new Set<string>();
  const paths: string[] = [];
  const total = Math.max(0, Math.trunc(count));
  for (let i = 0; i < total; i += 1) {
    const depth = rng.nextInt(3) === 0 ? 0 : 1 + rng.nextInt(2);
    const dirs = depth === 0 ? [] : rng.shuffle(PATH_SEGMENTS).slice(0, depth);
    const leaf = `${rng.pick(FILE_STEMS)}.${rng.pick(FILE_EXTENSIONS)}`;
    const base = [...dirs, leaf].join('/');
    let path = base;
    let suffix = 2;
    while (taken.has(path)) {
      const fileName = base.split('/').pop() ?? base;
      path = [...dirs, `${suffix}-${fileName}`].join('/');
      suffix += 1;
    }
    taken.add(path);
    paths.push(path);
  }
  return paths;
}

function makeBlobText(rng: DeterministicRng, sizeBytes: number): string {
  const size = Number.isFinite(sizeBytes) ? Math.max(0, Math.trunc(sizeBytes)) : 0;
  let out = '';
  while (out.length < size) {
    out += rng.pick(BLOB_WORDS);
    if (out.length < size) out += rng.chance(0.14) ? '\n' : ' ';
  }
  return out.slice(0, size);
}

function makeBlob(rng: DeterministicRng, path: string, sizeBytes: number): ScenarioBlob {
  const content = makeBlobText(rng, sizeBytes);
  return { path, content, base64: Buffer.from(content, 'utf8').toString('base64') };
}

function makeSentence(rng: DeterministicRng): string {
  return `${rng.pick(SENTENCE_STARTS)} ${rng.pick(SENTENCE_ENDS)}.`;
}

function makeBody(rng: DeterministicRng): string {
  const sentences: string[] = [];
  const count = 1 + rng.nextInt(3);
  for (let i = 0; i < count; i += 1) sentences.push(makeSentence(rng));
  return sentences.join(' ');
}

function makeCommitMessage(rng: DeterministicRng): string {
  const head = `${rng.pick(COMMIT_VERBS)} ${rng.pick(COMMIT_OBJECTS)}`;
  return rng.chance(0.35) ? `${head}\n\n${makeSentence(rng)}` : head;
}

function makeCommit(rng: DeterministicRng, author: ScenarioUser): ScenarioCommitTemplate {
  const epochSec = SCENARIO_EPOCH_SEC + rng.nextInt(NINETY_DAYS_SECONDS);
  return { message: makeCommitMessage(rng), author, epochSec, iso: isoFromEpochSec(epochSec) };
}

function makeIssue(rng: DeterministicRng): ScenarioIssueTemplate {
  return {
    title: `${rng.pick(ISSUE_ADJECTIVES)} ${rng.pick(ISSUE_SUBJECTS)}`,
    body: makeBody(rng),
    labels: rng.chance(0.5) ? [rng.pick(ISSUE_LABELS)] : [],
  };
}

function slugifySubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function makeBranchName(rng: DeterministicRng): string {
  const kind = rng.pick(BRANCH_KINDS);
  return `${kind}/${slugifySubject(rng.pick(PULL_SUBJECTS))}`;
}

function makePull(rng: DeterministicRng, base = 'main'): ScenarioPullTemplate {
  return {
    title: `${rng.pick(PULL_VERBS)} ${rng.pick(PULL_SUBJECTS)}`,
    body: makeBody(rng),
    head: makeBranchName(rng),
    base,
  };
}

// A branch name not already in `used`; on a collision a fresh name is drawn
// and the running suffix is appended to it.
function takeUniqueBranch(rng: DeterministicRng, used: Set<string>): string {
  let branch = makeBranchName(rng);
  let suffix = 2;
  while (used.has(branch)) {
    branch = `${makeBranchName(rng)}-${suffix}`;
    suffix += 1;
  }
  used.add(branch);
  return branch;
}

// ---------------------------------------------------------------- the scenario

export function buildScenario(): Scenario {
  const users = makeUsers(streamRng('users'), 12);
  const viewer = users[0] as ScenarioUser;
  const teammate = users[1] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;

  const orgRng = streamRng('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;

  const branchRng = streamRng('branches');
  const branchSet = new Set<string>(DEFAULT_BRANCHES);
  for (let i = 0; i < 8; i += 1) takeUniqueBranch(branchRng, branchSet);

  const filePaths = makeFilePaths(streamRng('paths'), 60);

  const blobRng = streamRng('blobs');
  const blobs: ScenarioBlob[] = [];
  for (const path of filePaths.slice(0, 24)) {
    const size = 64 + blobRng.nextInt(4033);
    blobs.push(makeBlob(blobRng, path, size));
  }

  const commitRng = streamRng('commits');
  const commitTemplates: ScenarioCommitTemplate[] = [];
  for (let i = 0; i < 60; i += 1) {
    const author = commitRng.pick(users);
    commitTemplates.push(makeCommit(commitRng, author));
  }

  const issueRng = streamRng('issues');
  const issueTemplates: ScenarioIssueTemplate[] = [];
  for (let i = 0; i < 60; i += 1) issueTemplates.push(makeIssue(issueRng));

  const pullRng = streamRng('pulls');
  const pullTemplates: ScenarioPullTemplate[] = [];
  for (let i = 0; i < 30; i += 1) pullTemplates.push(makePull(pullRng));

  const viewerRepos = makeRepos(streamRng('repos.viewer'), viewer.login, 30, 5000);
  const orgRepos = makeRepos(streamRng('repos.org'), org, 6, 6000);
  const strangerRepos = makeRepos(streamRng('repos.stranger'), stranger.login, 3, 7000);

  return {
    seed: SCENARIO_SEED_HEX,
    viewer,
    teammate,
    stranger,
    users,
    org,
    viewerRepos,
    orgRepos,
    strangerRepos,
    labels: [...ISSUE_LABELS],
    branches: [...branchSet],
    filePaths,
    blobs,
    commitTemplates,
    issueTemplates,
    pullTemplates,
  };
}
