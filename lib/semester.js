/**
 * 学期自动发现 — 从 historyCourseGrade 端点提取学期列表
 *
 * 解决 P0-2（semesterId=117 硬编码）和 P0-3（/api/semesters 恒返回 []）
 * 的根因：EAMS 学期日历由 JS 渲染，静态 cheerio 解析拿不到。
 *
 * 数据源：person!historyCourseGrade.action?projectType=MAJOR
 * 返回结构：表格行 [学年学期, 课程代码, 课程名称, 课程类别, 课程性质, 学分, 总评成绩, 绩点]
 */

const cheerio = require('cheerio');

/**
 * 从 historyCourseGrade HTML 中提取学期列表
 * @param {string} html
 * @returns {string[]} 学期字符串数组，如 ['2025-2026 1', '2025-2026 2']
 */
function extractSemestersFromHtml(html) {
  const $ = cheerio.load(html);
  const semesters = new Set();

  $('table').each((_, table) => {
    const headerRow = $(table).find('tr').filter((_, tr) => $(tr).find('th').length >= 2).first();
    const headers = headerRow.find('th').map((_, th) => $(th).text() || '').get();
    if (headers[0] !== '学年学期') return;

    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim() || '').get();
      if (cells.length >= 2 && cells[0] && cells[0].includes('-')) {
        semesters.add(cells[0]);
      }
    });
  });

  return [...semesters].sort();
}

/**
 * 从 historyCourseGrade HTML 中提取所有课程数据
 * @param {string} html
 * @returns {Array<{semester: string, courseCode: string, courseName: string, category: string, type: string, credit: string, score: string, gpa: string}>}
 */
function extractAllGradesFromHtml(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('table').each((_, table) => {
    const headerRow = $(table).find('tr').filter((_, tr) => $(tr).find('th').length >= 2).first();
    const headers = headerRow.find('th').map((_, th) => $(th).text() || '').get();
    if (headers[0] !== '学年学期') return;

    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim() || '').get();
      if (cells.length >= 8 && cells[0] && cells[0].includes('-')) {
        results.push({
          semester: cells[0],
          courseCode: cells[1],
          courseName: cells[2],
          category: cells[3],
          type: cells[4],
          credit: cells[5],
          score: cells[6],
          gpa: cells[7],
        });
      }
    });
  });

  return results;
}

/**
 * 将学期字符串映射为 EAMS semesterId
 * 公式：semesterId = 117 + (yy - 25) * 2 + (sem - 2)
 * 例如：2025-2026 1 → yy=25, sem=1 → 117 + 0*2 + (-1) = 116
 *       2025-2026 2 → yy=25, sem=2 → 117 + 0*2 + 0 = 117
 */
function semesterIdFromLabel(label) {
  const match = label.match(/(\d{4})-(\d{4})\s+(\d)/);
  if (!match) return null;
  const fullYy = parseInt(match[1]);
  const yy = fullYy - 2000; // 2025 → 25
  const sem = parseInt(match[3]);
  return 117 + (yy - 25) * 2 + (sem - 2);
}

/**
 * 将 semesterId 映射为学期字符串
 */
function semesterLabelFromId(id) {
  const diff = id - 117;
  const yearPair = Math.floor(diff / 2) + 25;
  const sem = diff % 2 + 2;
  return `20${yearPair}-20${yearPair + 1} ${sem}`;
}

module.exports = {
  extractSemestersFromHtml,
  extractAllGradesFromHtml,
  semesterIdFromLabel,
  semesterLabelFromId,
};
