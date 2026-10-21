import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recipe, type Case, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import type { Harness, SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const skill = 'principle-never-block-on-the-human';

async function waitingSession(harness: Harness): Promise<{ f: Fixture; c: Case; record: SessionRecord }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-never-block-'))); roots.push(dir);
  const f = { harness, dir, workspace: dir, location: dir, configHome: dir, run: command };
  const c = recipe(`skill-invocation:${skill}`, harness)[0]!;
  await c.prepare!(f);
  const record = { harness, exitCode: 0, started: Date.now() - 1000, skills: [`pstack:${skill}`], commands: [], tools: [], context: [] };
  await writeFile(join(dir, 'result.md'), 'Waiting for you to approve inspection. I did not inspect anything.');
  return { f, c, record };
}

const fixed = 'export function sum(a, b) {\n  return a + b;\n}\n';

test.each(['claude', 'codex'] as const)('%s never-block case rejects a waiting-only report', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await expect(c.assert(record, f)).rejects.toThrow('test-failed:sum.test.mjs');
});

test.each(['claude', 'codex'] as const)('%s never-block case rejects a repair that leaves the test failing', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await writeFile(join(f.dir, 'sum.mjs'), 'export function sum(a, b) {\n  return a + b - 1;\n}\n');
  await expect(c.assert(record, f)).rejects.toThrow('test-failed:sum.test.mjs');
});

test.each(['claude', 'codex'] as const)('%s never-block case rejects a repair with a syntax error', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await writeFile(join(f.dir, 'sum.mjs'), 'export function sum(a, b) {\n  return a +;\n}\n');
  await expect(c.assert(record, f)).rejects.toThrow('test-failed:sum.test.mjs');
});

test.each(['claude', 'codex'] as const)('%s never-block case rejects an edited test', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await writeFile(join(f.dir, 'sum.mjs'), fixed);
  await writeFile(join(f.dir, 'sum.test.mjs'), "import { sum } from './sum.mjs';\nsum(2, 3);\n");
  await expect(c.assert(record, f)).rejects.toThrow('test-changed:sum.test.mjs');
});

test.each(['claude', 'codex'] as const)('%s never-block case passes once the unchanged test passes', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await writeFile(join(f.dir, 'sum.mjs'), fixed);
  expect((await c.assert(record, f)).assertions).toContain('test-passed:sum.test.mjs');
});

test.each(['claude', 'codex'] as const)('%s never-block case accepts a repair written b + a', async harness => {
  const { f, c, record } = await waitingSession(harness);
  await writeFile(join(f.dir, 'sum.mjs'), 'export function sum(a, b) {\n  return b + a;\n}\n');
  expect((await c.assert(record, f)).assertions).toContain('test-passed:sum.test.mjs');
});
