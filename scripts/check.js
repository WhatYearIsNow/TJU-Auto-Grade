const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set([
  '.codex', '.eams_profile', '.playwright-mcp', '.git', 'node_modules',
]);

function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
  return files;
}

let failed = false;
for (const file of listJavaScriptFiles(root)) {
  const relative = path.relative(root, file);
  const source = fs.readFileSync(file, 'utf-8').replace(/^#!.*\r?\n/, '');
  try {
    new vm.Script(source, { filename: relative });
    console.log(`[OK] ${relative}`);
  } catch (error) {
    failed = true;
    console.error(`[FAIL] ${relative}: ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
