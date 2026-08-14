'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildUpdateEmail,
  diffGrades,
  gradeKey,
  loadGradeSnapshot,
  parseGradeRows,
  saveGradeSnapshot,
} = require('../eams_grade_checker');
const { mailConfig } = require('../mailer');

function grade(overrides = {}) {
  return {
    课程代码: 'MATH001',
    课程名称: '高等数学',
    学年学期: '2025-2026-1',
    教学班号: 'A01',
    总评成绩: 90,
    ...overrides,
  };
}

test('gradeKey distinguishes semesters and teaching classes', () => {
  assert.notEqual(
    gradeKey(grade()),
    gradeKey(grade({ 学年学期: '2025-2026-2' })),
  );
  assert.notEqual(
    gradeKey(grade()),
    gradeKey(grade({ 教学班号: 'A02' })),
  );
});

test('diffGrades reports new, updated, and removed courses', () => {
  const oldGrades = [
    grade(),
    grade({ 课程代码: 'PHY001', 课程名称: '大学物理', 总评成绩: 80 }),
  ];
  const newGrades = [
    grade({ 总评成绩: 95 }),
    grade({ 课程代码: 'ENG001', 课程名称: '大学英语', 总评成绩: 88 }),
  ];

  const changes = diffGrades(oldGrades, newGrades);
  assert.equal(changes.length, 3);
  assert.equal(changes.find(item => item.课程代码 === 'MATH001')._change, 'updated');
  assert.equal(changes.find(item => item.课程代码 === 'MATH001')._oldScore, 90);
  assert.equal(changes.find(item => item.课程代码 === 'ENG001')._change, 'new');
  assert.equal(changes.find(item => item.课程代码 === 'PHY001')._change, 'removed');
});

test('diffGrades preserves duplicate composite keys instead of overwriting them', () => {
  const duplicate = grade();
  const changes = diffGrades([duplicate, duplicate], [duplicate]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]._change, 'removed');
});

test('parseGradeRows normalizes headers, scores, and empty rows', () => {
  const parsed = parseGradeRows(
    ['课程 代码', '课程名称', '总评 成绩', '学年学期'],
    [
      ['MATH001', ' 高等数学 ', ' 95.5 ', '2025-2026-1'],
      ['PHY001', '大学物理', '', '2025-2026-1'],
      ['SHORT'],
    ],
  );

  assert.deepEqual(parsed, [{
    课程代码: 'MATH001',
    课程名称: '高等数学',
    总评成绩: 95.5,
    学年学期: '2025-2026-1',
  }]);
});

test('grade snapshots are saved atomically and restored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tju-grade-'));
  const snapshotPath = path.join(directory, 'grades.json');
  const grades = [grade()];

  try {
    assert.equal(loadGradeSnapshot(snapshotPath), null);
    saveGradeSnapshot(grades, snapshotPath);
    assert.deepEqual(loadGradeSnapshot(snapshotPath), grades);
    const updatedGrades = [grade({ 总评成绩: 99 })];
    saveGradeSnapshot(updatedGrades, snapshotPath);
    assert.deepEqual(loadGradeSnapshot(snapshotPath), updatedGrades);
    assert.equal(fs.existsSync(`${snapshotPath}.tmp`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('email HTML escapes values originating from the grade page', () => {
  const html = buildUpdateEmail([
    grade({ 课程名称: '<script>alert(1)</script>', _change: 'new' }),
  ]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('mailConfig supports QQ defaults and SMTP overrides', () => {
  const defaults = mailConfig({
    QQ_EMAIL: 'sender@example.com',
    QQ_SMTP_CODE: 'secret',
  });
  assert.equal(defaults.configured, true);
  assert.equal(defaults.host, 'smtp.qq.com');
  assert.equal(defaults.port, 465);
  assert.equal(defaults.secure, true);

  const custom = mailConfig({
    QQ_EMAIL: 'sender@example.com',
    QQ_SMTP_CODE: 'secret',
    SMTP_HOST: 'mail.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    NOTIFY_EMAIL: 'receiver@example.com',
  });
  assert.equal(custom.host, 'mail.example.com');
  assert.equal(custom.port, 587);
  assert.equal(custom.secure, false);
  assert.equal(custom.to, 'receiver@example.com');
});
