const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'web');
const template = fs.readFileSync(path.join(webDir, 'index.html'), 'utf-8');
const styles = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf-8')
  .replace(/<\/style/gi, '<\\/style');
const script = fs.readFileSync(path.join(webDir, 'app.js'), 'utf-8')
  .replace(/<\/script/gi, '<\\/script');

const html = template
  .replace(
    '<link rel="stylesheet" href="/styles.css">',
    `<style nonce="__DASHBOARD_NONCE__">\n${styles}\n</style>`,
  )
  .replace(
    '<script src="/app.js" defer></script>',
    `<script nonce="__DASHBOARD_NONCE__">\n${script}\n</script>`,
  );

if (html === template || html.includes('href="/styles.css"') || html.includes('src="/app.js"')) {
  throw new Error('无法生成单文件 HTML：没有找到预期的资源标签');
}

const output = path.join(webDir, 'dashboard.html');
if (process.argv.includes('--check')) {
  let current = '';
  try { current = fs.readFileSync(output, 'utf-8'); } catch {}
  if (current !== html) {
    console.error(`[FAIL] ${path.relative(root, output)} 不是最新版本，请运行 npm run build`);
    process.exitCode = 1;
  } else {
    console.log(`[OK] ${path.relative(root, output)} 已与源文件同步`);
  }
} else {
  fs.writeFileSync(output, html, 'utf-8');
  console.log(`[OK] ${path.relative(root, output)}`);
}
