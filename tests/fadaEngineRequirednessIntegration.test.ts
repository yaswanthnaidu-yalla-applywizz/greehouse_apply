import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const enginePath = '.agents/skills/fada/scripts/fada-engine.ts';
const configPath = '.agents/skills/fada/scripts/fada-config.ts';
const engine = readFileSync(enginePath, 'utf8');

assert.match(engine, /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\/utils\/fadaDatabaseConnectionString\.ts['"]/);
assert.match(engine, /getFadaDatabaseConnectionString\(process\.env\)/);
assert.ok(existsSync('src/utils/fadaDatabaseConnectionString.ts'));
assert.doesNotMatch(engine, /from ['"]\.\/fada-config\.ts['"]/);
assert.match(engine, /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\/utils\/fadaFieldRequiredness\.ts['"]/);
assert.match(engine, /const isReq = getPersistedRequiredness\(f\);/);
assert.doesNotMatch(engine, /Boolean\(f\.required\)/);
assert.equal(
  resolve('.agents/skills/fada/scripts/../../../../src/utils/fadaFieldRequiredness.ts'),
  resolve('src/utils/fadaFieldRequiredness.ts'),
);
assert.ok(existsSync('src/utils/fadaFieldRequiredness.ts'));

assert.throws(
  () => execFileSync('git', ['check-ignore', '-q', enginePath]),
  (error: unknown) => (error as { status?: number }).status === 1,
  'fada-engine.ts must be visible to Git',
);
assert.doesNotThrow(
  () => execFileSync('git', ['check-ignore', '-q', configPath]),
  'fada-config.ts must remain ignored',
);
assert.doesNotThrow(
  () => execFileSync('git', ['check-ignore', '-q', '.agents/skills/prp/SKILL.md']),
  'other .agents files must remain ignored',
);

console.log('FADA engine requiredness integration checks passed');
