const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ProcessGuard,
  inspectProcessHealth,
  readGradesSnapshot,
  writeGradesSnapshot,
} = require('../lib/storage');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('grade snapshots are written atomically and validated when read', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'grades.json');
  const grades = [{ '课程名称': '高等数学', '总评成绩': 95 }];
  writeGradesSnapshot(file, grades);
  assert.deepEqual(readGradesSnapshot(file), grades);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);

  fs.writeFileSync(file, '{}', 'utf-8');
  assert.throws(() => readGradesSnapshot(file), /格式不正确/);
});

test('process heartbeat distinguishes healthy and stale instances', t => {
  const directory = fixture(t);
  const pidFile = path.join(directory, '.pid');
  const heartbeatFile = path.join(directory, '.heartbeat');
  const script = path.join(directory, 'main.js');
  let clock = 1_700_000_000_000;
  const guard = new ProcessGuard({
    pidFile,
    heartbeatFile,
    script,
    pid: process.pid,
    now: () => clock,
  });
  guard.acquire();

  const inspect = () => inspectProcessHealth({
    pidFile,
    heartbeatFile,
    script,
    maxHeartbeatAgeMs: 60_000,
    now: () => clock,
  });
  assert.equal(inspect().status, 'healthy');
  clock += 60_001;
  assert.equal(inspect().status, 'stale');
  guard.release();
  assert.equal(inspect().status, 'stopped');
});
