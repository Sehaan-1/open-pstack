import { afterEach, describe, expect, test } from 'bun:test';
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

const harnesses: Harness[] = ['claude', 'codex'];
const sumWith = (body: string) => `export function sum(a, b) {\n${body}\n}\n`;

const recognized = [
  '  return a + b;',
  '  return a + b',
  '  return b + a;',
  '  return (a + b);',
  '  return ( b+a ) ;',
  '\treturn a+b;',
];

const unrecognized = [
  '  return a - b;',
  '  return a + b - 1;',
  '  return a +;',
  '  return (a + b;',
  '  return a + b; // fixed',
  '  return a + b; x();',
  '  return\n  a + b;',
  '  return a + b;\n  return 0;',
];

describe.each(harnesses)('%s never-block case', harness => {
  test.each(recognized)('accepts %j and the fixture test passes on it', async body => {
    const { f, c, record } = await waitingSession(harness);
    await writeFile(join(f.dir, 'sum.mjs'), sumWith(body));
    expect((await c.assert(record, f)).assertions).toEqual(expect.arrayContaining(['recognized-repair:sum.mjs', 'test-unchanged:sum.test.mjs']));
    await command(['bun', 'sum.test.mjs'], { cwd: f.dir });
  });

  test.each(unrecognized)('rejects %j', async body => {
    const { f, c, record } = await waitingSession(harness);
    await writeFile(join(f.dir, 'sum.mjs'), sumWith(body));
    await expect(c.assert(record, f)).rejects.toThrow('repair-not-recognized:sum.mjs');
  });

  test('rejects an edited test', async () => {
    const { f, c, record } = await waitingSession(harness);
    await writeFile(join(f.dir, 'sum.mjs'), sumWith('  return a + b;'));
    await writeFile(join(f.dir, 'sum.test.mjs'), "import { sum } from './sum.mjs';\nsum(2, 3);\n");
    await expect(c.assert(record, f)).rejects.toThrow('test-changed:sum.test.mjs');
  });
});
