import { afterEach, describe, expect, test } from 'bun:test';
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.ts';
import { linkCodexAuth } from './isolation.ts';
import { codexInstallation, launch, MacDriver, parseSession, verifyCodexEnabled } from './harness.ts';
import { verifyProjectDoctor } from '../features/recipes.ts';
import { newReceipt } from './core.ts';
import { sourceDigest } from './provenance.ts';
import { evidence, verify } from './verify.ts';
import { command, freshRoot, isolatedEnv, retainedFile, treeHash, type Command, type Session } from './io.ts';
import { REPO, type Harness, type Installation, type Receipt } from './types.ts';
const roots: string[] = [];
const gitEnv = { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
async function fixture(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-test-'))); roots.push(root); return root; }
const originalEnv = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function loginFixture(root: string): Promise<string> {
  const home = join(root, 'daily-codex');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'auth.json'), 'opaque existing login');
  await writeFile(join(home, 'daily-state'), 'do not touch');
  process.env.CODEX_HOME = home;
  return join(home, 'auth.json');
}

describe('isolated harness boundaries', () => {
  test('candidate environment keeps operator identity while isolating provider configuration', () => {
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
      GH_TOKEN: process.env.GH_TOKEN, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.HOME = '/operator/home'; process.env.USER = 'operator-user'; process.env.LOGNAME = 'operator-login';
    process.env.GH_TOKEN = 'test-publisher-token'; process.env.CODEX_HOME = '/daily/codex';
    process.env.CLAUDE_CONFIG_DIR = '/daily/claude'; process.env.ANTHROPIC_API_KEY = 'daily-anthropic'; process.env.OPENAI_API_KEY = 'daily-openai';
    try {
      for (const harness of ['claude', 'codex'] as const) {
        const env = isolatedEnv('/run/state', harness);
        expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.HOME).toBe('/operator/home'); expect(env.USER).toBe('operator-user'); expect(env.LOGNAME).toBe('operator-login');
        expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null'); expect(env.TMPDIR).toBe('/run/state/tmp');
        expect(env.CLAUDE_CONFIG_DIR).toBe('/daily/claude'); expect(env.CODEX_HOME).toBe('/run/state/.codex');
        expect(env.GH_CONFIG_DIR).toBe('/run/state/.config/gh');
        expect(JSON.stringify(env)).not.toContain('/daily/codex');
      }
      const claude = launch('claude', '/candidate', { cwd: '/run/state/fixture', addDirs: [] });
      expect(claude.slice(0, 2)).toEqual(['claude', '-p']);
      expect(claude.join(' ')).toContain('--plugin-dir /candidate/plugins/pstack --settings {"enabledPlugins":{"pstack@open-pstack":false}} --permission-mode dontAsk');
      expect(claude.join(' ')).not.toContain('/run/state');
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(isolatedEnv('/run/state', 'claude').CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(launch('codex', '/candidate', { cwd: '/candidate', addDirs: ['/run/state/fixture'] })).toEqual(['codex', 'exec', '--json', '--skip-git-repo-check',
        '--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"', '--sandbox', 'workspace-write', '--cd', '/candidate', '--add-dir', '/run/state/fixture', '-']);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  test('candidate environment requires the real operator identity', () => {
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    try {
      delete process.env.HOME;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('Real HOME');
      process.env.HOME = '/operator/home'; delete process.env.USER;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('USER and LOGNAME');
      process.env.USER = 'operator-user'; delete process.env.LOGNAME;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('USER and LOGNAME');
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  test('doctor blocks non-Mac and missing isolation interfaces, retaining reasons', async () => {
    const root = await fixture();
    const run: Command = async args => args.includes('--version') ? 'version' : '';
    await expect(doctor(root, run, 'linux')).rejects.toThrow('operator Mac');
    expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('blocked');
    await expect(doctor(root, run, 'darwin', true)).rejects.toThrow('isolation missing');
  });
  test('doctor probes without installing or reading daily authentication', async () => {
    const calls: string[][] = [], root = await fixture();
    const run: Command = async args => { calls.push(args); return args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --json local path'; };
    await doctor(root, run, 'darwin', true);
    expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('pass');
    expect(calls.every(c => c.includes('--help') || c.includes('--version'))).toBe(true);
  });
  test('project self-test accepts real candidate doctor output through canonical workspace paths', async () => {
    const root = await fixture(), workspace = join(root, 'workspace');
    const skill = await realpath(join(import.meta.dir, '..'));
    await mkdir(join(workspace, '.claude/skills'), { recursive: true });
    await symlink(skill, join(workspace, '.claude/skills/verify-open-pstack'));
    const alias = join(root, 'workspace-alias'); await symlink(workspace, alias);
    const run: Command = async args => args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --json local path';
    await doctor(root, run, 'darwin', false, []);
    const parentText = await readFile(join(root, 'doctor.json'), 'utf8');
    await expect(verifyProjectDoctor([parentText], workspace)).rejects.toThrow('passing child doctor');
    await doctor(root, run, 'darwin', true);
    const text = await readFile(join(root, 'doctor.json'), 'utf8');
    expect(JSON.parse(text).candidate).toBe(true); expect(JSON.parse(text).skill).toBe(skill);
    await verifyProjectDoctor(['not JSON', text], workspace);
    await verifyProjectDoctor([text], alias);
    const other = join(root, 'other-workspace');
    await mkdir(join(other, '.claude/skills/verify-open-pstack'), { recursive: true });
    await expect(verifyProjectDoctor([text], other)).rejects.toThrow('passing child doctor');
    await expect(verifyProjectDoctor(['{}'], workspace)).rejects.toThrow('passing child doctor');
    await expect(verifyProjectDoctor([JSON.stringify({ ...JSON.parse(text), result: 'blocked' })], workspace)).rejects.toThrow('passing child doctor');
  });

  test.each([false, true])('prepare pins local Git candidate and links existing Codex login (install failure=%s)', async failInstall => {
    const root = await fixture(), repository = join(root, 'repository'), operatorHome = join(root, 'operator-home'), calls: string[][] = [];
    const auth = await loginFixture(root);
    for (const manifest of ['.claude-plugin', '.codex-plugin']) {
      const dir = join(repository, 'plugins/pstack', manifest); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plugin.json'), JSON.stringify({ version: 'test' }));
    }
    await mkdir(join(repository, '.claude/skills/verify-open-pstack'), { recursive: true });
    await writeFile(join(repository, '.claude/skills/verify-open-pstack/SKILL.md'), 'pinned project skill');
    await mkdir(join(repository, '.agents/skills'), { recursive: true });
    await symlink('../../.claude/skills/verify-open-pstack', join(repository, '.agents/skills/verify-open-pstack'));
    await command(['git', 'init', repository], { env: gitEnv });
    await command(['git', 'add', '.'], { cwd: repository, env: gitEnv });
    await command(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: repository, env: gitEnv });
    const sha = (await command(['git', 'rev-parse', 'HEAD'], { cwd: repository, env: gitEnv })).trim(), actualGit: Command = command;
    await mkdir(operatorHome, { mode: 0o700 });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    const run: Command = async (args, options = {}) => {
      calls.push(args);
      const env = options.env, candidate = Boolean(env?.CODEX_HOME?.startsWith(join(root, 'state') + '/'));
      if (candidate) {
        const stateHome = join(env!.CODEX_HOME!, '..');
        expect(env!.HOME).toBe(operatorHome); expect(env!.USER).toBe('operator-user'); expect(env!.LOGNAME).toBe('operator-login');
        expect(env!.CLAUDE_CONFIG_DIR).toBe(join(operatorHome, 'claude-config')); expect(env!.CODEX_HOME).toBe(join(stateHome, '.codex'));
        expect(env!.TMPDIR).toBe(join(stateHome, 'tmp')); expect(env!.GH_CONFIG_DIR).toBe(join(stateHome, '.config/gh'));
        expect(env!.GH_TOKEN).toBeUndefined(); expect(env!.GITHUB_TOKEN).toBeUndefined();
        for (const dir of [stateHome, env!.TMPDIR!, env!.CODEX_HOME!, env!.GH_CONFIG_DIR!]) {
          const info = await stat(dir); expect(info.isDirectory()).toBe(true); expect(info.mode & 0o777).toBe(0o700);
        }
        await expect(stat(join(stateHome, '.claude'))).rejects.toThrow('ENOENT');
        await expect(stat(join(stateHome, 'settings.json'))).rejects.toThrow('ENOENT');
      }
      if (args[0] === 'git') {
        const local = [...args];
        if (args[1] === 'clone') local[local.length - 2] = repository;
        return actualGit(local, options);
      }
      if (args.includes('--version')) return 'version';
      if (args.includes('--help')) return '--plugin-dir --settings --setting-sources --json local path';
      if (args[0] === 'codex' && args[1] === 'plugin') {
        const linked = join(env!.CODEX_HOME!, 'auth.json');
        expect((await lstat(linked)).isSymbolicLink()).toBe(true);
        expect(await readlink(linked)).toBe(auth);
        if (failInstall) throw new Error('fixture installation failed');
        if (args[2] === 'marketplace') return '{}';
        if (args[2] === 'add') {
          const installedPath = join(env!.CODEX_HOME!, 'plugins/pstack');
          await cp(join(env!.CODEX_HOME!, '../workspace/plugins/pstack'), installedPath, { recursive: true });
          return JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath });
        }
        if (args[2] === 'list') return JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: true }] });
      }
      throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
    };
    const sessions: string[][] = [];
    const record: Session = async (args, options) => {
      sessions.push(args);
      expect(options.env.CODEX_HOME!.startsWith(join(root, 'state') + '/')).toBe(true); expect(options.env.HOME).toBe(operatorHome);
      const linked = join(options.env.CODEX_HOME!, 'auth.json');
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect(await readlink(linked)).toBe(auth);
      await writeFile(options.stdout, 'retained raw native evidence');
      throw new Error('fixture native surface reached');
    };
    const driver = new MacDriver(run, record);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      process.env.HOME = operatorHome; process.env.USER = 'operator-user'; process.env.LOGNAME = 'operator-login';
      process.env.CLAUDE_CONFIG_DIR = join(operatorHome, 'claude-config');
      const receipt = newReceipt(111, sha, sha, true, root), preparation = driver.prepare(receipt);
      if (failInstall) await expect(preparation).rejects.toThrow('fixture installation failed');
      else {
        const installs = await preparation; receipt.installations = installs;
        expect(installs.map(i => i.harness)).toEqual(['claude', 'codex']);
        expect(installs.every(i => i.sha === sha)).toBe(true);
        expect(installs.every(i => /^[a-f0-9]{64}$/.test(i.sourceHash!))).toBe(true);
        expect(installs[0]!.sourceHash).toBe(installs[1]!.sourceHash);
        expect(calls.some(c => c.join(' ') === 'codex plugin add pstack@open-pstack --json')).toBe(true);
        for (const installation of installs) {
          const one = newReceipt(111, sha, sha, true, root); one.installations = [installation];
          await expect(driver.exercise(one)).rejects.toThrow('fixture native surface reached');
        }
        expect(sessions.map(args => args[0])).toEqual(['claude', 'codex']);
      }
    } finally {
      await mkdir(join(root, 'artifacts'), { mode: 0o700 });
      await writeFile(join(root, 'artifacts/private.txt'), 'private raw evidence', { mode: 0o600 });
      for (const harness of ['claude', 'codex']) await writeFile(join(root, 'state', harness, 'native-state.db'), 'retained candidate state');
      await driver.cleanup(); await driver.cleanup();
      Object.defineProperty(process, 'platform', platform);
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    expect(calls.some(c => c.includes('auth') || c.includes('login'))).toBe(false);
    expect(calls.some(c => c[0] === '/usr/bin/sandbox-exec')).toBe(false);
    expect(await readFile(join(root, 'artifacts/private.txt'), 'utf8')).toBe('private raw evidence');
    expect(await readFile(auth, 'utf8')).toBe('opaque existing login');
    expect(await readFile(join(auth, '../daily-state'), 'utf8')).toBe('do not touch');
    expect((await stat(join(root, 'artifacts'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'artifacts/private.txt'))).mode & 0o777).toBe(0o600);
    for (const harness of ['claude', 'codex']) {
      const home = join(root, 'state', harness); expect((await stat(home)).isDirectory()).toBe(true);
      expect(await readFile(join(home, 'native-state.db'), 'utf8')).toBe('retained candidate state');
      await expect(stat(join(home, '.codex'))).rejects.toThrow('ENOENT');
      await expect(stat(join(home, '.claude'))).rejects.toThrow('ENOENT');
      if (!failInstall) expect(await readFile(join(root, 'sessions', harness, 'project-skill/doctor.jsonl'), 'utf8')).toBe('retained raw native evidence');
    }
  });
  test.each([['claude', false], ['claude', true], ['codex', false], ['codex', true]] as const)('%s setup interruption restores exact bytes or forbids publication (restore failure=%s)', async (harness, failRestore) => {
    const root = await fixture(), home = join(root, 'state', harness), workspace = join(home, 'workspace');
    process.env.HOME = root;
    const config = join(root, harness === 'claude' ? 'daily-claude' : '.codex'); process.env.CLAUDE_CONFIG_DIR = join(root, 'daily-claude');
    const instructions = harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    for (const path of ['plugins/pstack', '.claude/skills/verify-open-pstack', '.agents/skills']) await mkdir(join(workspace, path), { recursive: true });
    await symlink('../../.claude/skills/verify-open-pstack', join(workspace, '.agents/skills/verify-open-pstack'));
    await writeFile(join(workspace, 'plugins/pstack/SKILL.md'), 'candidate setup');
    await mkdir(config);
    const original = Buffer.from([0, 13, 10, 255, 97]);
    await writeFile(join(config, instructions), original);
    if (harness === 'codex') await writeFile(join(config, 'pstack-models.md'), original);
    const receipt = newReceipt(111, 'a'.repeat(40), 'b'.repeat(40), false, root);
    receipt.runFeatures = [`${harness}:setup`];
    receipt.installations = [{ harness, home, location: join(workspace, 'plugins/pstack'), sha: receipt.sha, cliVersion: 'test', pluginVersion: 'test', treeHash: await treeHash(join(workspace, 'plugins/pstack')), sourceHash: await sourceDigest(workspace) }];
    const driver = new MacDriver(command, async args => {
      expect(args[0]).toBe(harness);
      await writeFile(join(config, instructions), 'changed by setup');
      await writeFile(join(config, 'pstack-models.md'), 'created by setup');
      if (harness === 'codex') await writeFile(join(config, 'CLAUDE.md'), 'created by setup');
      if (failRestore) { await rm(join(config, instructions)); await mkdir(join(config, instructions)); }
      throw new Error('interrupted setup');
    });
    await expect(driver.exercise(receipt)).rejects.toThrow(failRestore ? 'Setup restoration requires a regular file' : 'interrupted setup');
    if (failRestore) {
      await expect(driver.cleanup()).rejects.toThrow('Setup restoration requires a regular file');
      await rm(join(config, instructions), { recursive: true });
      await expect(driver.cleanup()).rejects.toThrow('Setup restoration failed; publication forbidden');
      return;
    }
    await driver.cleanup();
    expect(await readFile(join(config, instructions))).toEqual(original);
    if (harness === 'codex') {
      expect(await readFile(join(config, 'pstack-models.md'))).toEqual(original);
      await expect(stat(join(config, 'CLAUDE.md'))).rejects.toThrow('ENOENT');
    } else await expect(stat(join(config, 'pstack-models.md'))).rejects.toThrow('ENOENT');
  });
  test('Codex exact installed tree and enabled listing are required', async () => {
    const root = await fixture(), plugin = join(root, 'config/plugins/pstack');
    await mkdir(plugin, { recursive: true }); await writeFile(join(plugin, 'SKILL.md'), 'candidate');
    const hash = await treeHash(plugin), receipt = JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath: plugin });
    expect(await codexInstallation(receipt, root, hash)).toBe(plugin);
    await expect(codexInstallation(receipt, root, 'bad')).rejects.toThrow('differs');
    await expect(codexInstallation('{}', root, hash)).rejects.toThrow('Unrecognized');
    expect(() => verifyCodexEnabled(JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: true }] }))).not.toThrow();
    expect(() => verifyCodexEnabled(JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: false }] }))).toThrow('enabled');
    const outside = await fixture(); await writeFile(join(outside, 'SKILL.md'), 'candidate');
    await expect(codexInstallation(JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath: outside }), root, hash)).rejects.toThrow('escaped');
  });
  test('plugin symlinks and evidence outside retained root are rejected', async () => {
    const root = await fixture(), outside = await fixture();
    await writeFile(join(outside, 'secret'), 'outside'); await symlink(join(outside, 'secret'), join(root, 'escape'));
    await expect(treeHash(root)).rejects.toThrow('symlink');
    await expect(retainedFile(root, 'escape')).rejects.toThrow('within output');
    await writeFile(join(root, 'reviewed.txt'), 'native surface');
    expect((await retainedFile(root, 'reviewed.txt')).sha256).toMatch(/^[a-f0-9]{64}$/);
    await mkdir(join(root, 'state')); await writeFile(join(root, 'state/raw'), 'raw');
    await expect(retainedFile(root, 'state/raw')).rejects.toThrow('outside isolated state');
  });
  test('output must be fresh and outside the repository', async () => {
    const root = await fixture(), repo = join(root, 'repo'); await mkdir(repo);
    await expect(freshRoot(join(repo, 'output'), repo)).rejects.toThrow('outside');
    await expect(freshRoot(root, repo)).rejects.toThrow();
    expect(await freshRoot(join(root, 'output'), repo)).toBe(join(root, 'output'));
  });
});

async function candidate(harness: Harness): Promise<{ root: string; installation: Installation }> {
  const root = await fixture(), home = join(root, 'state', harness), workspace = join(home, 'workspace');
  for (const path of ['plugins/pstack', '.claude/skills/verify-open-pstack', '.agents/skills']) await mkdir(join(workspace, path), { recursive: true });
  await symlink('../../.claude/skills/verify-open-pstack', join(workspace, '.agents/skills/verify-open-pstack'));
  await writeFile(join(workspace, 'plugins/pstack/SKILL.md'), 'candidate plugin');
  const location = join(workspace, 'plugins/pstack');
  return { root, installation: { harness, home, location, sha: 'a'.repeat(40), cliVersion: 'test', pluginVersion: 'test', treeHash: await treeHash(location), sourceHash: await sourceDigest(workspace) } };
}
function selected(root: string, installation: Installation, features: string[]): Receipt {
  const receipt = newReceipt(111, 'a'.repeat(40), 'b'.repeat(40), false, root);
  receipt.runFeatures = features.map(feature => `${installation.harness}:${feature}`);
  receipt.installations = [installation];
  return receipt;
}
const lines = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n') + '\n';
function claudeStream(options: { command?: string; skill?: string }): string {
  const events: unknown[] = [];
  if (options.command) events.push({ type: 'user', isReplay: true, message: { role: 'user', content: `<command-name>/${options.command}</command-name>` } });
  if (options.skill) events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: options.skill } }] } });
  events.push({ type: 'result', subtype: 'success', is_error: false, result: 'It passed.' });
  return lines(events);
}
function stub(stream: string, effect?: (cwd: string) => Promise<void>, exitCode = 0): { record: Session; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, record: async (args, options) => {
    calls.push(args);
    await writeFile(options.stdout, stream); await writeFile(options.stderr, '');
    // Linux file timestamps are coarser than Date.now(); a real session runs for seconds before it writes.
    await Bun.sleep(20);
    await effect?.(options.cwd);
    return exitCode;
  } };
}
const writeResult = async (cwd: string) => { await writeFile(join(cwd, 'result.md'), 'the skill result'); };

describe('headless recipes', () => {
  test('Codex completed commands keep their captured output and failure state', () => {
    const stream = [
      { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'pending', aggregated_output: '', exit_code: null } },
      { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'true', aggregated_output: 'out\n', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1 } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'I ran it.' } },
    ].map(event => JSON.stringify(event)).join('\n');
    const record = parseSession('codex', stream, 0, 0);
    expect(record.reply).toBe('I ran it.');
    expect(record.commands).toEqual(['true']);
    expect(record.tools).toEqual([
      { name: 'command', id: 'item_1', input: { command: 'true' }, result: 'out\n', parent: null, failed: false },
      { name: 'command', id: 'item_2', input: { command: 'false' }, result: '', parent: null, failed: true },
    ]);
  });
  test('each harness keeps the final assistant text as the reply, or empty text when there is none', () => {
    expect(parseSession('claude', lines([
      { type: 'result', subtype: 'success', is_error: false, result: 'Early.' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Not the result.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'SETUP-DONE' },
    ]), 0, 0).reply).toBe('SETUP-DONE');
    expect(parseSession('claude', lines([{ type: 'assistant', message: { content: [{ type: 'text', text: 'No result.' }] } }]), 0, 0).reply).toBe('');
    expect(parseSession('codex', lines([
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'First.' } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'ACCEPT-ROUTED' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'true', aggregated_output: '', exit_code: 0 } },
      { type: 'item.started', item: { id: 'item_3', type: 'agent_message', text: 'Unfinished.' } },
    ]), 0, 0).reply).toBe('ACCEPT-ROUTED');
    expect(parseSession('codex', lines([{ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'true', exit_code: 0 } }]), 0, 0).reply).toBe('');
  });
  test('missing or unsupported recipes fail before any session starts', async () => {
    const { root, installation } = await candidate('codex');
    for (const [feature, reason] of [['mystery', 'missing-recipe:codex/mystery'], ['assets:codex', 'unsupported-native-consumer']]) {
      const { record, calls } = stub(claudeStream({ command: 'pstack:architect' }), writeResult);
      await expect(new MacDriver(command, record).exercise(selected(root, installation, ['skill-invocation:architect', feature!]))).rejects.toThrow(reason);
      expect(calls).toHaveLength(0);
    }
  });

  test('setup runs after every other feature so later checks see the default model sheet', async () => {
    const { root, installation } = await candidate('codex');
    const prompts: string[] = [];
    const record: Session = async (_args, options) => {
      prompts.push(options.input);
      await writeFile(options.stdout, claudeStream({ command: 'pstack:architect' })); await writeFile(options.stderr, '');
      return 1;
    };
    await expect(new MacDriver(command, record).exercise(selected(root, installation, ['setup', 'skill-invocation:architect']))).rejects.toThrow();
    expect(prompts[0]).toContain('$pstack:architect');
  });

  test('default skill recipe records machine-checked assertions from a candidate load and a fixture file', async () => {
    const { root, installation } = await candidate('claude');
    const { record, calls } = stub(claudeStream({ command: 'pstack:architect' }), writeResult);
    const receipt = selected(root, installation, ['skill-invocation:architect']);
    receipt.observations = await new MacDriver(command, record).exercise(receipt);
    expect(calls[0]!.slice(0, 2)).toEqual(['claude', '-p']);
    const [observation] = receipt.observations;
    expect(observation!.reviewer).toBe('recipe');
    expect(observation!.assertions).toEqual(['invoke:exit-0', 'invoke:skill-loaded', 'invoke:file:result.md']);
    expect(observation!.transcript).toBe('sessions/claude/skill-invocation-architect/invoke.jsonl');
    expect(observation!.artifacts.map(a => a.path)).toEqual(['sessions/claude/skill-invocation-architect/invoke.result.md']);
    const comment = evidence(receipt);
    expect(comment).toContain(`result ${observation!.observed}; 3 assertions machine-checked`);
    expect(comment).not.toContain('[value omitted]');
  });

  test('principle leaves load through the Skill tool', async () => {
    const { root, installation } = await candidate('claude');
    const { record } = stub(claudeStream({ skill: 'pstack:principle-prove-it-works' }), writeResult);
    const receipt = selected(root, installation, ['skill-invocation:principle-prove-it-works']);
    expect((await new MacDriver(command, record).exercise(receipt))[0]!.assertions).toContain('invoke:skill-loaded');
  });

  test('poteto-agent preload reads the child reply and rejects child tool calls, errors and a missing principle', async () => {
    const { root, installation } = await candidate('claude');
    const stream = (reply: string, options: { childTool?: string; error?: boolean } = {}) => lines([
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'pstack:poteto-agent' } }] } },
      ...options.childTool ? [{ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { content: [{ type: 'tool_use', id: 'toolu_child', name: options.childTool, input: {} }] } }] : [],
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', is_error: !!options.error, content: [{ type: 'text', text: reply }] }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'The first is Laziness Protocol.' },
    ]);
    const run = (s: string) => new MacDriver(command, stub(s).record).exercise(selected(root, installation, ['agent-preload:poteto-agent']));
    const [observation] = await run(stream('The first is **Laziness Protocol**.'));
    expect(observation!.assertions).toEqual(['dispatch:exit-0', 'dispatch:agent-dispatched', 'dispatch:child-no-tools', 'dispatch:principle-named']);
    expect(observation!.artifacts.map(a => a.path)).toEqual(['sessions/claude/agent-preload-poteto-agent/dispatch.child-reply.txt']);
    await expect(run(stream('The first is **Laziness Protocol**.', { childTool: 'Bash' }))).rejects.toThrow('child-used-tools');
    await expect(run(stream('poteto-mode was not preloaded.'))).rejects.toThrow('principle-missing:Laziness Protocol');
    await expect(run(stream('Laziness Protocol', { error: true }))).rejects.toThrow('agent-not-dispatched');
  });

  test('startup hook recipe needs the installed context in the harness record, not in a reply', async () => {
    const context = '<EXTREMELY_IMPORTANT>\nYou have pstack.\n</EXTREMELY_IMPORTANT>\n';
    const hooked = async (harness: Harness) => {
      const { root, installation } = await candidate(harness), workspace = join(installation.home, 'workspace');
      await mkdir(join(installation.location, 'hooks'));
      await writeFile(join(installation.location, 'hooks/session-start-context.md'), context);
      return { root, installation: { ...installation, treeHash: await treeHash(installation.location), sourceHash: await sourceDigest(workspace) } };
    };
    const reply = { type: 'assistant', message: { content: [{ type: 'text', text: context }] } };
    const claude = await hooked('claude');
    const runClaude = (hook: Record<string, unknown>) => new MacDriver(command, stub(lines([
      { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', exit_code: 0, outcome: 'success', stdout: context, ...hook }, reply,
    ])).record).exercise(selected(claude.root, claude.installation, ['hook:startup']));
    const [observation] = await runClaude({});
    expect(observation!.assertions).toEqual(['startup:exit-0', 'startup:hook-context-injected']);
    expect(observation!.artifacts.map(a => a.path)).toEqual(['sessions/claude/hook-startup/startup.session-context.md']);
    for (const hook of [{ exit_code: 1, outcome: 'error' }, { stdout: '' }, { hook_event: 'UserPromptSubmit' }]) {
      await expect(runClaude(hook)).rejects.toThrow('hook-context-missing');
    }
    const codex = await hooked('codex'), thread = '01a130b0-6128-7253-abc0-6e8fa3b2cd25';
    await loginFixture(codex.root); await linkCodexAuth(codex.installation.home);
    const runCodex = async (role: string) => {
      const sessions = join(codex.installation.home, '.codex/sessions/2026/10/12');
      await mkdir(sessions, { recursive: true });
      await writeFile(join(sessions, `rollout-2026-10-12T11-17-08-${thread}.jsonl`), lines([
        { type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: context.trimEnd() }] } },
      ]));
      return new MacDriver(command, stub(lines([{ type: 'thread.started', thread_id: thread },
        { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: context } }])).record)
        .exercise(selected(codex.root, codex.installation, ['hook:startup']));
    };
    expect((await runCodex('developer'))[0]!.assertions).toEqual(['startup:exit-0', 'startup:hook-context-injected']);
    await expect(runCodex('user')).rejects.toThrow('hook-context-missing');
  });

  test('a success claim with no fixture file fails', async () => {
    const { root, installation } = await candidate('claude');
    const claim = stub(claudeStream({ command: 'pstack:architect' }));
    await expect(new MacDriver(command, claim.record).exercise(selected(root, installation, ['skill-invocation:architect']))).rejects.toThrow('fixture-file-missing:result.md');
  });

  test('an assertion failure fails the run and publishes no observation or success', async () => {
    const { root, installation } = await candidate('claude');
    const mac = new MacDriver(command, stub(claudeStream({ command: 'pstack:architect' })).record);
    const comments: string[] = [], statuses: string[] = [], sha = 'a'.repeat(40), base = 'b'.repeat(40);
    await expect(verify({ pr: 111, selfTest: false, features: ['claude:skill-invocation:architect'], root, publisherRevision: 'c'.repeat(40), persist: async () => {},
      registry: { skills: ['architect'], shared: [], catalog: [], assets: [], setup: [], runner: [], tools: [], project: [], nonRuntime: [] },
      github: {
        async pull() { return { number: 111, head: { sha }, base: { sha: base }, state: 'open', headRepo: REPO }; },
        async files() { return [{ filename: 'plugins/pstack/skills/architect/SKILL.md' }]; },
        async comment(_pr, body) { comments.push(body); return `https://github.com/${REPO}/pull/111#issuecomment-1`; },
        async status(_sha, state) { statuses.push(state); },
      },
      driver: { preflight: async () => {}, prepare: async () => [installation], exercise: receipt => mac.exercise(receipt), cleanup: () => mac.cleanup() },
    })).rejects.toThrow('fixture-file-missing:result.md');
    expect(statuses).toEqual(['failure']);
    expect(comments.join('\n')).not.toContain('Observation');
    expect(comments.join('\n')).toContain('FAILED');
  });
});
