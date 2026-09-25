const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  diffGrades,
  createGradeNotification,
  escapeHtml,
  buildWeightedEmail,
  gradeKey,
} = require('../../lib/grades');

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');
    assert.strictEqual(escapeHtml('x "y" z'), 'x &quot;y&quot; z');
    assert.strictEqual(escapeHtml('normal'), 'normal');
  });
});

describe('gradeKey', () => {
  it('identifies grades by identity fields', () => {
    const g1 = { '课程名称': '数学', '课程代码': 'MATH101' };
    const g2 = { '课程名称': '数学', '课程代码': 'MATH101' };
    const g3 = { '课程名称': '物理', '课程代码': 'PHY101' };
    assert.strictEqual(gradeKey(g1), gradeKey(g2));
    assert.notStrictEqual(gradeKey(g1), gradeKey(g3));
  });
});

describe('diffGrades', () => {
  it('detects score change using Chinese field names', () => {
    const old = [{ '课程名称': '数学', '总评成绩': '80' }];
    const now = [{ '课程名称': '数学', '总评成绩': '90' }];
    const diffs = diffGrades(old, now);
    assert.strictEqual(diffs.length, 1);
    // diffGrades 返回的是新成绩对象，课程名在 '课程名称' 字段
    assert.strictEqual(diffs[0]['课程名称'], '数学');
    assert.strictEqual(diffs[0]._change, 'updated');
  });

  it('returns empty when no changes', () => {
    const grades = [{ '课程名称': '数学', '总评成绩': '80' }];
    const diffs = diffGrades(grades, grades);
    assert.strictEqual(diffs.length, 0);
  });

  it('detects new course', () => {
    const old = [];
    const now = [{ '课程名称': '物理', '总评成绩': '85' }];
    const diffs = diffGrades(old, now);
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0]['课程名称'], '物理');
    assert.strictEqual(diffs[0]._change, 'new');
  });

  it('detects removed course', () => {
    const old = [{ '课程名称': '化学', '总评成绩': '75' }];
    const now = [];
    const diffs = diffGrades(old, now);
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0]['课程名称'], '化学');
    assert.strictEqual(diffs[0]._change, 'removed');
  });

  it('detects credit change', () => {
    const old = [{ '课程名称': '数学', '总评成绩': '80', '学分': 3 }];
    const now = [{ '课程名称': '数学', '总评成绩': '80', '学分': 4 }];
    const diffs = diffGrades(old, now);
    // 现在 GRADE_CHANGE_FIELDS 包含学分
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0]['课程名称'], '数学');
  });
});

describe('createGradeNotification', () => {
  it('creates a valid notification event', () => {
    const change = {
      '课程名称': '数学',
      _change: 'updated',
      _oldValues: { '总评成绩': '80' },
      '总评成绩': '90',
    };
    const event = createGradeNotification(change);
    assert.ok(event.id);
    assert.ok(event.subject);
    assert.ok(event.body);
  });
});

describe('buildWeightedEmail', () => {
  it('renders weighted grade email from table data', () => {
    const data = {
      summary: ['加权平均分 85.5'],
      tableGrades: [
        ['表头', '课程数', '总学分', '平均绩点', '加权平均成绩'],
        ['数据', '30', '96', '3.5', '85.5'],
      ],
    };
    const html = buildWeightedEmail(data);
    assert.ok(html.includes('加权'));
    assert.ok(html.includes('85.5'));
  });

  it('returns error message when data is insufficient', () => {
    const html = buildWeightedEmail({ tableGrades: [] });
    assert.ok(html.includes('未能获取'));
  });
});
