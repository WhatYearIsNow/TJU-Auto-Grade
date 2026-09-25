const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  extractSemestersFromHtml,
  extractAllGradesFromHtml,
  semesterIdFromLabel,
  semesterLabelFromId,
} = require('../../lib/semester');

describe('semesterIdFromLabel', () => {
  it('maps 2025-2026 1 to id 116', () => {
    assert.strictEqual(semesterIdFromLabel('2025-2026 1'), 116);
  });

  it('maps 2025-2026 2 to id 117', () => {
    assert.strictEqual(semesterIdFromLabel('2025-2026 2'), 117);
  });

  it('maps 2024-2025 1 to id 114', () => {
    assert.strictEqual(semesterIdFromLabel('2024-2025 1'), 114);
  });

  it('maps 2024-2025 2 to id 115', () => {
    assert.strictEqual(semesterIdFromLabel('2024-2025 2'), 115);
  });

  it('returns null for invalid label', () => {
    assert.strictEqual(semesterIdFromLabel('invalid'), null);
    assert.strictEqual(semesterIdFromLabel(''), null);
  });
});

describe('semesterLabelFromId', () => {
  it('maps id 116 to 2024-2025 1', () => {
    assert.strictEqual(semesterLabelFromId(116), '2024-2025 1');
  });

  it('maps id 117 to 2025-2026 2', () => {
    assert.strictEqual(semesterLabelFromId(117), '2025-2026 2');
  });

  it('maps id 118 to 2025-2026 3', () => {
    assert.strictEqual(semesterLabelFromId(118), '2025-2026 3');
  });
});

describe('extractSemestersFromHtml', () => {
  it('extracts semesters from historyCourseGrade HTML', () => {
    const html = `
      <table>
        <tr><th>学年学期</th><th>课程代码</th><th>课程名称</th></tr>
        <tr><td>2025-2026 1</td><td>1140003</td><td>法制安全教育</td></tr>
        <tr><td>2025-2026 2</td><td>2111430</td><td>英语听说</td></tr>
        <tr><td>2024-2025 1</td><td>1140001</td><td>基础课</td></tr>
      </table>
    `;
    const semesters = extractSemestersFromHtml(html);
    assert.deepStrictEqual(semesters, ['2024-2025 1', '2025-2026 1', '2025-2026 2']);
  });

  it('returns empty for non-grade tables', () => {
    const html = '<table><tr><th>姓名</th><th>年龄</th></tr></table>';
    const semesters = extractSemestersFromHtml(html);
    assert.deepStrictEqual(semesters, []);
  });
});

describe('extractAllGradesFromHtml', () => {
  it('extracts all grade rows with correct fields', () => {
    const html = `
      <table>
        <tr><th>学年学期</th><th>课程代码</th><th>课程名称</th><th>课程类别</th><th>课程性质</th><th>学分</th><th>总评成绩</th><th>绩点</th></tr>
        <tr><td>2025-2026 1</td><td>1140003</td><td>法制安全教育</td><td>文化素质教育</td><td>必修</td><td>0</td><td>P</td><td>0</td></tr>
        <tr><td>2025-2026 1</td><td>2111430</td><td>英语听说</td><td>B级</td><td>必修</td><td>1</td><td>79</td><td>3</td></tr>
      </table>
    `;
    const grades = extractAllGradesFromHtml(html);
    assert.strictEqual(grades.length, 2);
    assert.strictEqual(grades[0].semester, '2025-2026 1');
    assert.strictEqual(grades[0].courseCode, '1140003');
    assert.strictEqual(grades[0].courseName, '法制安全教育');
    assert.strictEqual(grades[0].credit, '0');
    assert.strictEqual(grades[0].score, 'P');
    assert.strictEqual(grades[0].gpa, '0');
  });

  it('returns empty for non-grade tables', () => {
    const html = '<table><tr><th>姓名</th><th>年龄</th></tr></table>';
    const grades = extractAllGradesFromHtml(html);
    assert.deepStrictEqual(grades, []);
  });
});
