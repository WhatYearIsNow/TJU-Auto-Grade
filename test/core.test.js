const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeQP,
  decodeRFC2047,
  createGradeNotification,
  diffGrades,
  extractReplyText,
  extractTextBody,
  parseGradeTables,
  parseCommand,
} = require('../eams_grade_checker_v2');

test('diffGrades distinguishes retakes in different semesters', () => {
  const oldGrades = [
    { '学年学期': '2024-2025-1', '课程代码': 'MATH001', '课程名称': '高等数学', '总评成绩': 80 },
  ];
  const newGrades = [
    { '学年学期': '2024-2025-1', '课程代码': 'MATH001', '课程名称': '高等数学', '总评成绩': 80 },
    { '学年学期': '2025-2026-1', '课程代码': 'MATH001', '课程名称': '高等数学', '总评成绩': 92 },
  ];

  const changes = diffGrades(oldGrades, newGrades);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]._change, 'new');
  assert.equal(changes[0]['学年学期'], '2025-2026-1');
});

test('diffGrades distinguishes teaching classes in the same semester', () => {
  const oldGrades = [
    { '学年学期': '2025-2026-1', '课程代码': 'MATH001', '课程名称': '高等数学', '教学班': '01', '总评成绩': 80 },
    { '学年学期': '2025-2026-1', '课程代码': 'MATH001', '课程名称': '高等数学', '教学班': '02', '总评成绩': 85 },
  ];
  const newGrades = [
    oldGrades[0],
    { ...oldGrades[1], '总评成绩': 90 },
  ];

  const changes = diffGrades(oldGrades, newGrades);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]['教学班'], '02');
  assert.equal(changes[0]._oldScore, 85);
});

test('diffGrades notices component-score changes and preserves removed metadata', () => {
  const oldGrades = [
    { '学年学期': '2025-2026-1', '课程代码': 'A', '课程名称': '课程A', '总评成绩': 90, '平时成绩': 80 },
    { '学年学期': '2025-2026-1', '课程代码': 'B', '课程名称': '课程B', '总评成绩': 70, '学分': 2 },
  ];
  const newGrades = [
    { '学年学期': '2025-2026-1', '课程代码': 'A', '课程名称': '课程A', '总评成绩': 90, '平时成绩': 85 },
  ];

  const changes = diffGrades(oldGrades, newGrades);
  assert.deepEqual(changes[0]._changedFields, ['平时成绩']);
  assert.deepEqual(changes[0]._oldValues, { '平时成绩': 80 });
  assert.equal(changes[1]._change, 'removed');
  assert.equal(changes[1]['课程名称'], '课程B');
  assert.equal(changes[1]['学分'], 2);
});

test('grade notification IDs deduplicate the same transition', () => {
  const oldGrade = { '学年学期': '2025-2026-1', '课程代码': 'A', '课程名称': '课程A', '总评成绩': 80 };
  const newGrade = { ...oldGrade, '总评成绩': 90 };
  const firstChange = diffGrades([oldGrade], [newGrade])[0];
  const repeatedChange = diffGrades([oldGrade], [newGrade])[0];
  const differentTransition = diffGrades([{ ...oldGrade, '总评成绩': 85 }], [newGrade])[0];

  assert.equal(
    createGradeNotification(firstChange, [newGrade]).id,
    createGradeNotification(repeatedChange, [newGrade]).id,
  );
  assert.notEqual(
    createGradeNotification(firstChange, [newGrade]).id,
    createGradeNotification(differentTransition, [newGrade]).id,
  );
});

test('quoted-printable and RFC 2047 decoding supports Chinese commands', () => {
  assert.equal(decodeQP('=E7=8A=B6=E6=80=81'), '状态');
  assert.equal(decodeRFC2047('=?UTF-8?B?54q25oCB?='), '状态');
  assert.equal(decodeRFC2047('=?UTF-8?Q?=E7=8A=B6=E6=80=81?='), '状态');
});

test('extractTextBody supports LF-only multipart email', () => {
  const email = [
    'Content-Type: multipart/alternative; boundary="demo"',
    '',
    '--demo',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E6=88=90=E7=BB=A9=E5=8D=95',
    '--demo--',
    '',
  ].join('\n');

  assert.equal(extractTextBody(email), '成绩单');
});

test('extractReplyText ignores quoted history', () => {
  const email = [
    'Content-Type: text/plain; charset=UTF-8',
    '',
    '状态',
    '',
    '-----Original Message-----',
    '成绩单',
  ].join('\r\n');

  assert.equal(extractReplyText(email), '状态');
});

test('parseCommand recognizes supported Chinese and English commands', () => {
  assert.equal(parseCommand('请给我看一下状态'), 'status');
  assert.equal(parseCommand('总加权'), 'weighted');
  assert.equal(parseCommand('成绩单'), 'grades');
  assert.equal(parseCommand('log'), 'log');
  assert.equal(parseCommand('help'), 'help');
  assert.equal(parseCommand('普通邮件正文'), null);
});

test('parseGradeTables normalizes rows and ignores unrelated tables', () => {
  const grades = parseGradeTables([
    { headers: ['标题'], rows: [{ cells: ['忽略'] }] },
    {
      headers: ['课程代码', '课程名称', '总评成绩', '教学班'],
      rows: [
        { className: '', cells: ['MATH001', ' 高等数学 ', ' 95 ', '01'] },
        { className: 'title', cells: ['-', '标题行', '-', '-'] },
      ],
    },
  ]);

  assert.deepEqual(grades, [{
    '课程代码': 'MATH001',
    '课程名称': '高等数学',
    '总评成绩': 95,
    '教学班': '01',
  }]);
});
