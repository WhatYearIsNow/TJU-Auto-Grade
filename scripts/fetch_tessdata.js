#!/usr/bin/env node
/**
 * 下载 tesseract 英文语言包到项目 tessdata/ 目录，供离线（云服务器）识别使用。
 * 用法: node scripts/fetch_tessdata.js
 * 已存在且校验通过时直接跳过；多个镜像源依次尝试。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const TARGET_DIR = path.resolve(__dirname, '..', 'tessdata');
const TARGET_FILE = path.join(TARGET_DIR, 'eng.traineddata.gz');
const MIN_BYTES = 100 * 1024; // 正常语言包约 1-4MB

const SOURCES = [
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz',
  'https://unpkg.com/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz',
  'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
];

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 15_000, headers: { 'User-Agent': 'tju-auto-grade-fetch' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        return resolve(download(next, redirectsLeft - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const chunks = [];
      // 硬性总时长保护：单源超过 60s 即放弃，切换下一个镜像
      const hardTimer = setTimeout(() => request.destroy(new Error('单源下载超过 60s，切换镜像')), 60_000);
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { clearTimeout(hardTimer); resolve(Buffer.concat(chunks)); });
      response.on('error', error => { clearTimeout(hardTimer); reject(error); });
    });
    request.on('timeout', () => request.destroy(new Error('15s 内无数据，切换镜像')));
    request.on('error', reject);
  });
}

async function main() {
  if (fs.existsSync(TARGET_FILE)) {
    const stat = fs.statSync(TARGET_FILE);
    if (stat.size >= MIN_BYTES) {
      console.log(`[skip] 语言包已存在: ${TARGET_FILE} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      return;
    }
    fs.unlinkSync(TARGET_FILE);
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  let lastError = null;
  for (const source of SOURCES) {
    process.stdout.write(`[try] ${source}\n`);
    try {
      const buffer = await download(source);
      if (buffer.length < MIN_BYTES) throw new Error(`文件过小（${buffer.length} 字节），疑似错误页面`);
      if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) throw new Error('不是有效的 gzip 文件');
      const tmpFile = `${TARGET_FILE}.download`;
      fs.writeFileSync(tmpFile, buffer);
      fs.renameSync(tmpFile, TARGET_FILE);
      console.log(`[ok] 已保存 ${TARGET_FILE} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[fail] ${error.message}`);
    }
  }
  console.error('全部镜像下载失败。可改用 npm 源兜底（Windows 10+ / Ubuntu 均自带 tar）：');
  console.error('  npm pack @tesseract.js-data/eng@1.0.0');
  console.error('  tar -xzf tesseract.js-data-eng-1.0.0.tgz');
  console.error('  把 package/4.0.0/eng.traineddata.gz 放到项目 tessdata/ 目录。最后错误:', lastError?.message);
  process.exit(1);
}

main();
