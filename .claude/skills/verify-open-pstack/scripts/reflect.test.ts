import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recipe, type Case, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import { parseSession } from './harness.ts';
import type { Harness, SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const chat = '00000000-1111-2222-3333-444444444444';

async function fixture(harness: Harness): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-reflect-recipe-'))); roots.push(dir);
  const workspace = resolve(import.meta.dir, '../../../..'), location = join(dir, 'installed-pstack');
  await symlink(join(workspace, 'plugins/pstack'), location);
  return { harness, dir, workspace, location, configHome: dir, run: command };
}

const home = (f: Fixture) => join(f.dir, 'transcript-home');
const claudeTranscript = (f: Fixture) => join(home(f), 'projects/fixture/known.jsonl');
const opener = async (f: Fixture): Promise<{ uuid: string; text: string }> => {
  const record = JSON.parse((await readFile(claudeTranscript(f), 'utf8')).split('\n')[1]!);
  return { uuid: record.uuid, text: record.message.content[0].text };
};
async function claudeReport(f: Fixture, available: boolean): Promise<Record<string, unknown>> {
  const { uuid, text } = await opener(f);
  return available
    ? { status: 'resolved', path: claudeTranscript(f), opening_user_message: { line: 2, characters: text.length, sha256: hash(text), uuid } }
    : { status: 'unresolved', reason: 'opening_message_mismatch', fallback: 'session_digest', uuid };
}
const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const launcher = (f: Fixture) => join(f.location, 'skills/poteto-mode/scripts/resolve-codex-transcript');
const lookup = (f: Fixture) => `CODEX_HOME=${home(f)} ${launcher(f)} ${chat}`;
const tool = (name: string, input: Record<string, any>, result: string | undefined, failed = false): SessionRecord['tools'][number] =>
  ({ name, id: 'item_1', input, result, parent: null, failed });

async function launch(f: Fixture): Promise<string> {
  const child = Bun.spawn([launcher(f), chat], { env: { ...process.env, CODEX_HOME: home(f) }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(stderr).toBe('');
  return stdout;
}

async function simulatedRecord(f: Fixture, available: boolean): Promise<SessionRecord> {
  let tools: SessionRecord['tools'];
  if (f.harness === 'codex') {
    tools = [tool('command', { command: `/bin/zsh -lc '${lookup(f)}'` }, await launch(f))];
  } else {
    await writeFile(join(f.dir, 'result.json'), JSON.stringify(await claudeReport(f, available)));
    tools = [tool('Bash', { command: `cat -n ${claudeTranscript(f)}` }, await readFile(claudeTranscript(f), 'utf8'))];
  }
  if (!available) await writeFile(join(f.dir, 'digest.md'), 'The requested opening is missing from this synthetic fixture.');
  return { harness: f.harness, exitCode: 0, started: Date.now() - 1000, skills: ['pstack:reflect'], commands: [], tools, context: [] };
}

async function prepared(harness: Harness, index = 0): Promise<{ f: Fixture; c: Case; record: SessionRecord }> {
  const f = await fixture(harness), c = recipe('skill-invocation:reflect', harness)[index]!;
  await c.prepare!(f);
  return { f, c, record: await simulatedRecord(f, index === 0) };
}

test.each(['claude', 'codex'] as const)('%s Reflect recipes verify the opening and the digest fallback rather than a generic result', async harness => {
  const cases = recipe('skill-invocation:reflect', harness);
  expect(cases.map(c => c.id)).toEqual(['locate-transcript', 'digest-fallback']);
  for (const index of [0, 1]) {
    const { f, c, record } = await prepared(harness, index), available = index === 0;
    expect((await c.assert(record, f)).assertions).toContain(available ? 'opening-verified' : 'digest-fallback');
    expect(c.prompt(f)).toContain(harness === 'claude' ? '/pstack:reflect' : '$pstack:reflect');
    await expect(c.assert({ ...record, skills: [] }, f)).rejects.toThrow('skill-not-loaded');
    if (harness === 'codex') await expect(c.assert({ ...record, tools: [] }, f)).rejects.toThrow('reflect-resolver-not-run');
    if (available) {
      await writeFile(join(f.dir, 'digest.md'), 'An unneeded digest.');
      await expect(c.assert(record, f)).rejects.toThrow('reflect-unneeded-fallback');
    } else {
      for (const [content, reason] of [[' \n\t ', 'reflect-digest-empty'], ['', 'fixture-file-missing'], ['word '.repeat(2001), 'reflect-digest-budget']]) {
        await writeFile(join(f.dir, 'digest.md'), content!);
        await expect(c.assert(record, f)).rejects.toThrow(reason!);
      }
    }
  }
});

test('both Codex cases prepare in one fixture, each from a fresh index', async () => {
  const f = await fixture('codex'), [located, fallback] = recipe('skill-invocation:reflect', 'codex');
  await located!.prepare!(f);
  await fallback!.prepare!(f);
  await fallback!.assert(await simulatedRecord(f, false), f);
});

test.each(['claude', 'codex'] as const)('%s prompts name neither the resolver nor the per-run nonce', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), prompt = c.prompt(f);
    const nonce = harness === 'codex'
      ? (await readdir(join(home(f), 'sessions/2026/10/11')))[0]!.replace(/^rollout-|\.jsonl$/g, '')
      : (await opener(f)).uuid;
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    for (const leak of [nonce, 'resolve-codex-transcript', 'poteto-mode/scripts', 'known.jsonl', 'state_5.sqlite']) expect(prompt).not.toContain(leak);
  }
});

test('Codex accepts the launcher or the script, installed or by realpath, however the command is spelled', async () => {
  const { f, c, record } = await prepared('codex'), output = record.tools[0]!.result!;
  const script = `${launcher(f)}.ts`;
  for (const commandText of [lookup(f), `bun ${script} ${chat}`, `cd /tmp && CODEX_HOME="${home(f)}" "${await realpath(launcher(f))}" ${chat} # lookup`,
    `/bin/bash -lc 'bun --no-env-file ${await realpath(script)} ${chat} 2>&1'`]) {
    await c.assert({ ...record, tools: [tool('command', { command: commandText }, output)] }, f);
  }
});

test.each(['claude', 'codex'] as const)('%s fixtures write requested and unrelated openers of equal length but different content and hashes', async harness => {
  const written = async (index: number) => {
    const { f } = await prepared(harness, index);
    if (harness === 'claude') return (await opener(f)).text;
    const dir = join(home(f), 'sessions/2026/10/11'), [name] = await readdir(dir);
    return JSON.parse((await readFile(join(dir, name!), 'utf8')).split('\n')[2]!).payload.content[0].text as string;
  };
  const [requested, unrelated] = [await written(0), await written(1)];
  expect(requested).toBe('Reflect on the corrections in this disposable session.');
  expect(unrelated.length).toBe(requested.length);
  expect(unrelated).not.toBe(requested);
  expect(hash(unrelated)).not.toBe(hash(requested));
});

test('Codex rejects output from another fixture, another run, or a command that does not name the resolver', async () => {
  const { f, c, record } = await prepared('codex'), [good] = record.tools;
  const other = await prepared('codex');
  const stale = JSON.parse(good!.result!);
  await c.prepare!(f);
  for (const changed of [
    good!, tool('command', good!.input, other.record.tools[0]!.result),
    tool('command', { command: `echo '${JSON.stringify(stale)}'` }, good!.result), tool('command', { command: `cat ${f.dir}/report.json` }, good!.result),
    tool('command', good!.input, good!.result, true), tool('command', good!.input, 'not json'),
  ]) {
    await expect(c.assert({ ...record, tools: [changed] }, f)).rejects.toThrow('reflect-resolver-not-run');
  }
  const fresh = await launch(f);
  await c.assert({ ...record, tools: [tool('command', good!.input, fresh)] }, f);
  await c.assert({ ...record, tools: [tool('command', good!.input, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(fresh)).reverse())))] }, f);
});

test('Claude accepts the exact report naming the opener record\'s uuid in both cases, whichever tool read the transcript', async () => {
  for (const index of [0, 1]) {
    const { f, c, record } = await prepared('claude', index), path = claudeTranscript(f), { text } = await opener(f);
    const [metadata, user] = (await readFile(path, 'utf8')).trimEnd().split('\n');
    for (const tools of [
      [tool('Read', { file_path: path }, `1\t${metadata}\n2\t${user}`)],
      [tool('Glob', { pattern: `${join(home(f), 'projects/fixture')}/*.jsonl` }, path), tool('Grep', { pattern: '"type":"user"', path }, `2:${user}`)],
      [tool('Bash', { command: `python3 -I - ${path} <<'EOF'\nprint(uuid, sha)\nEOF` }, `line 2 uuid ${JSON.parse(user!).uuid} sha ${hash(text)}`)],
    ]) await c.assert({ ...record, tools }, f);
  }
});

const withUuid = (report: any, uuid: string | undefined) =>
  report.opening_user_message ? { ...report, opening_user_message: { ...report.opening_user_message, uuid } } : { ...report, uuid };

test('Claude rejects a report without the opener record\'s uuid, with another run\'s, or with the right uuid and a wrong value', async () => {
  for (const index of [0, 1]) {
    const available = index === 0, { f, c, record } = await prepared('claude', index), good = await claudeReport(f, available);
    const mismatch = available ? 'reflect-opening-mismatch' : 'reflect-fallback-mismatch', { uuid: otherRun } = await opener((await prepared('claude', index)).f);
    const wrongValue = available ? { ...good, opening_user_message: { ...good.opening_user_message as object, sha256: hash('another opener') } } : { ...good, path: claudeTranscript(f) };
    for (const report of [withUuid(good, undefined), withUuid(good, otherRun), wrongValue, { ...good, extra: true }]) {
      await writeFile(join(f.dir, 'result.json'), JSON.stringify(report));
      await expect(c.assert(record, f)).rejects.toThrow(mismatch);
    }
    await writeFile(join(f.dir, 'result.json'), JSON.stringify(good));
    await c.assert(record, f);
    await c.prepare!(f);
    await expect(c.assert(record, f)).rejects.toThrow(mismatch);
  }
});

test('Claude judges a report written in the native stream by its uuid, not by which tools ran', async () => {
  for (const index of [0, 1]) {
    const { f, c, record } = await prepared('claude', index), good = await claudeReport(f, index === 0);
    const events = (report: object) => [
      { type: 'user', isReplay: true, message: { content: '<command-name>/pstack:reflect</command-name>' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: join(f.dir, 'result.json'), content: JSON.stringify(report) } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write', is_error: false, content: 'File created successfully.' }] } },
      { type: 'result', subtype: 'success', result: 'Resolved.' },
    ].map(event => JSON.stringify(event)).join('\n');
    const write = async (report: object) => {
      await writeFile(join(f.dir, 'result.json'), JSON.stringify(report));
      return c.assert(parseSession('claude', events(report), 0, record.started), f);
    };
    await write(good);
    await expect(write(withUuid(good, undefined))).rejects.toThrow(index === 0 ? 'reflect-opening-mismatch' : 'reflect-fallback-mismatch');
  }
});

test('Codex requires a completed resolver command in the native stream and rejects failed, pending or claimed execution', async () => {
  const { f, c, record } = await prepared('codex'), { command: exact } = record.tools[0]!.input, output = record.tools[0]!.result!;
  const rollout = JSON.stringify({ type: 'response_item', payload: { content: [{ text: '<skill>\n<name>pstack:reflect</name>\n<path>/run/.codex/plugins/cache/open-pstack/pstack/test/skills/reflect/SKILL.md</path>' }] } });
  const item = (exit_code: number | null) => ({ id: 'item_1', type: 'command_execution', command: exact, aggregated_output: output, exit_code });
  for (const event of [
    { type: 'item.completed', item: item(1) }, { type: 'item.completed', item: item(null) }, { type: 'item.started', item: item(0) },
    { type: 'item.completed', item: { type: 'agent_message', text: `I ran ${exact} and it printed ${output}` } },
  ]) {
    await expect(c.assert(parseSession('codex', JSON.stringify(event), 0, record.started, rollout), f)).rejects.toThrow('reflect-resolver-not-run');
  }
  await c.assert(parseSession('codex', JSON.stringify({ type: 'item.completed', item: item(0) }), 0, record.started, rollout), f);
});
