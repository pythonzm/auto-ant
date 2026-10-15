import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const script = new URL('./ant-batch-visit.mjs', import.meta.url);
const mock = new URL('./test-fixtures/mock-ant.mjs', import.meta.url);
function run({ fail = false, hold = 0, repeat = fail ? 1 : 2, expectInput = false, expectCompleted = null } = {}) {
  const env = { ...process.env, MOCK_FAIL: fail ? '1' : '0' };
  if (expectInput) env.MOCK_EXPECT_INPUT = '1';
  if (expectCompleted) env.MOCK_EXPECT_COMPLETED = String(expectCompleted);
  delete env.NODE_TEST_CONTEXT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-visits-'));
  const out = fs.openSync(path.join(dir, 'stdout'), 'w');
  const err = fs.openSync(path.join(dir, 'stderr'), 'w');
  const result = spawnSync(process.execPath, ['--import', mock.href, script.pathname,
    '--core-id', 'mock', '--count', '2', '--repeat', String(repeat),
    '--url', 'https://example.test/a', '--url', 'https://example.test/b',
    '--no-proxy', '--hold', String(hold), '--wait-load', '0', '--retry', '0', '--json'],
  { encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err);
  result.stdout = fs.readFileSync(path.join(dir, 'stdout'), 'utf8');
  result.stderr = fs.readFileSync(path.join(dir, 'stderr'), 'utf8');
  fs.rmSync(dir, { recursive: true });
  return result;
}
test('profiles and separate tabs navigate concurrently; repeats reuse tabs', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.length, 8);
  for (const row of report.results) {
    assert.equal(row.ok, true);
    assert.equal(row.reqs, 1, 'request lists must be isolated');
    assert.equal(JSON.parse(row.state).url, row.url);
    assert.equal(row.targetId, row.tab === 1 ? 'first' : 'second');
    assert.deepEqual(row.popups, []);
  }
});
test('one profile failing does not stop others or trigger premature cleanup', () => {
  const r = run({ fail: true });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /intentional failure/);
  assert.doesNotMatch(r.stderr, /AssertionError/);
});
test('hold period dispatches human-like mouse interactions', () => {
  const r = run({ hold: 2, repeat: 1, expectInput: true, expectCompleted: 4 });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results.length, 4);
  for (const row of report.results) {
    assert.equal(row.ok, true);
    assert.equal(row.reqs, 1, 'request lists must be isolated');
  }
});
