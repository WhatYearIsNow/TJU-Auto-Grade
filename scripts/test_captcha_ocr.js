#!/usr/bin/env node
/**
 * 离线验证码识别率测试（不启动浏览器、不联网调用大模型）
 *
 * 用法:
 *   单张: node scripts/test_captcha_ocr.js samples/a1b2.png [--dump]
 *   目录: node scripts/test_captcha_ocr.js samples/
 *
 * 目录模式下，若文件名形如 "a1b2_xxx.png" / "A1B2.png"，
 * 会把首个 4-6 位字母数字段当真值，统计识别准确率。
 *
 * 可选参数:
 *   --scale N         放大倍数（默认 2）
 *   --threshold N     二值化阈值，rgb 之和（默认 80，越小越严格，仅 bin 模式生效）
 *   --preprocess M    gray（默认，灰度放大）或 bin（硬二值化，干扰线多时尝试）
 *   --dump            把预处理后的图片存到原图旁边（*.bin.png），用于人工调参
 */

const fs = require('fs');
const path = require('path');
const { recognizeCode, preprocess, shutdown } = require('../lib/captcha_ocr');

function parseArgs(argv) {
  const positional = [];
  const options = { dump: false, scale: 2, threshold: 80, preprocess: 'gray' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dump') options.dump = true;
    else if (argv[i] === '--scale') options.scale = Number(argv[++i]);
    else if (argv[i] === '--threshold') options.threshold = Number(argv[++i]);
    else if (argv[i] === '--preprocess') options.preprocess = argv[++i];
    else positional.push(argv[i]);
  }
  return { target: positional[0], options };
}

function expectedFromName(file) {
  const match = path.basename(file).match(/^([0-9a-zA-Z]{4,6})(?:[_.]|$)/);
  return match ? match[1] : null;
}

async function recognizeOne(file, config, dump) {
  const started = Date.now();
  const buffer = fs.readFileSync(file);
  if (dump) {
    const binFile = file.replace(/(\.[a-z]+)$/i, '.bin$1');
    fs.writeFileSync(binFile, preprocess(buffer, config));
    process.stdout.write(`  二值化结果: ${binFile}\n`);
  }
  const code = await recognizeCode(buffer, config);
  return { code, ms: Date.now() - started };
}

async function main() {
  const { target, options } = parseArgs(process.argv.slice(2));
  if (!target) {
    console.error('用法: node scripts/test_captcha_ocr.js <图片文件或目录> [--dump] [--scale N] [--threshold N]');
    process.exit(1);
  }
  const config = {
    captchaScale: options.scale,
    captchaThreshold: options.threshold,
    captchaPreprocess: options.preprocess,
    tessdataDir: path.resolve(__dirname, '..', 'tessdata'),
  };

  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target)
      .filter(name => /\.(png|jpe?g)$/i.test(name) && !/\.bin\./i.test(name))
      .map(name => path.join(target, name))
    : [target];

  if (files.length === 0) {
    console.error('未找到 png/jpg 验证码样本');
    process.exit(1);
  }

  let correct = 0;
  let evaluable = 0;
  for (const file of files) {
    const expected = expectedFromName(file);
    try {
      const { code, ms } = await recognizeOne(file, config, options.dump);
      const mark = expected ? (code?.toLowerCase() === expected.toLowerCase() ? 'OK ' : 'XX ') : '   ';
      if (expected) {
        evaluable += 1;
        if (code?.toLowerCase() === expected.toLowerCase()) correct += 1;
      }
      process.stdout.write(`${mark}${path.basename(file)} -> ${code || '(空)'}${expected ? ` / 真值 ${expected}` : ''} (${ms}ms)\n`);
    } catch (error) {
      process.stdout.write(`ER ${path.basename(file)} -> ${error.message}\n`);
    }
  }

  if (evaluable > 0) {
    const rate = ((correct / evaluable) * 100).toFixed(1);
    process.stdout.write(`\n识别率: ${correct}/${evaluable} = ${rate}%（单张成功率；autoLogin 另有 3 次换图重试）\n`);
  }
  await shutdown();
}

main().catch(async error => {
  console.error(error);
  await shutdown();
  process.exit(1);
});
