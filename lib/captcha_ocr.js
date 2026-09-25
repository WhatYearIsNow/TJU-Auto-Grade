/**
 * 本地验证码识别（无需大模型 / 无需外部 API Key）
 *
 * 方案参考 kissTJU 扩展 chuxuan.js 的 fx_sso_fixForm：验证码先做图像预处理再交给
 * tesseract.js（WASM，纯本地）识别。本模块在此基础上增加：灰度/二值化两种预处理、
 * 最近邻放大、字符白名单、单行模式、worker 单例复用、离线语言包。
 *
 * 设计要点：
 * - tesseract worker 创建成本高（加载 wasm + 语言数据），全局只建一个并复用；
 * - 语言包优先读项目 tessdata/ 目录（离线可用），缺失时回退官方 CDN 并只警告一次；
 * - 解码同时支持 PNG / JPEG（CAS /cas/code 实际输出格式以 JPEG 居多），全部为纯 JS 解码，无原生编译依赖。
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const DEFAULT_WHITELIST = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEFAULT_THRESHOLD = 80;   // bin 模式下的二值化阈值（rgb 之和），复刻 kissTJU 线上参数
const DEFAULT_SCALE = 2;        // 小图放大倍数，样本实测 2x 优于 3x
const DEFAULT_MODE = 'gray';    // gray=灰度放大（默认，实测更稳）；bin=硬二值化（干扰线多时尝试）
const CODE_PATTERN = /[a-zA-Z0-9]{4,6}/;

let workerPromise = null;
let warnedOffline = false;

function decodeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new Error('验证码图片数据为空');
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return PNG.sync.read(buffer);
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return jpeg.decode(buffer, { maxMemoryUsageInMB: 64, formatAsRGBA: true });
  }
  // 兜底按 JPEG 尝试（部分响应头与内容不一致）
  try {
    return jpeg.decode(buffer, { maxMemoryUsageInMB: 64, formatAsRGBA: true });
  } catch (error) {
    throw new Error(`未知的验证码图片格式: ${error.message}`);
  }
}

/**
 * 预处理 + 最近邻放大，返回 PNG Buffer。
 * gray 模式（默认）：转灰度并放大，保留抗锯齿笔画，tesseract 内部再做二值化，样本实测更稳；
 * bin 模式：按阈值 r+g+b<threshold 硬二值化（复刻 kissTJU），验证码干扰线/噪点多时可切换尝试。
 * 纯函数，不依赖 tesseract，便于单测。
 * @param {Buffer} buffer 原始图片
 * @param {{scale?:number, threshold?:number, preprocess?:string}} [options]
 */
function preprocess(buffer, options = {}) {
  const scale = Number.isInteger(options.scale) && options.scale >= 1 && options.scale <= 6
    ? options.scale : DEFAULT_SCALE;
  const threshold = Number.isFinite(options.threshold) && options.threshold >= 0 && options.threshold <= 765
    ? options.threshold : DEFAULT_THRESHOLD;
  const mode = options.preprocess === 'bin' ? 'bin' : DEFAULT_MODE;

  const source = decodeImage(buffer);
  const width = source.width * scale;
  const height = source.height * scale;
  const output = new PNG({ width, height });

  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const srcIndex = (source.width * y + x) << 2;
      let value;
      if (mode === 'bin') {
        value = source.data[srcIndex] + source.data[srcIndex + 1] + source.data[srcIndex + 2] < threshold
          ? 0 : 255;
      } else {
        value = Math.round(
          0.299 * source.data[srcIndex] +
          0.587 * source.data[srcIndex + 1] +
          0.114 * source.data[srcIndex + 2],
        );
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const dstIndex = (width * (y * scale + dy) + (x * scale + dx)) << 2;
          output.data[dstIndex] = value;
          output.data[dstIndex + 1] = value;
          output.data[dstIndex + 2] = value;
          output.data[dstIndex + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(output);
}

function resolveTessdataOptions(config = {}) {
  const tessdataDir = config.tessdataDir || path.join(__dirname, '..', 'tessdata');
  const localTraineddata = path.join(tessdataDir, 'eng.traineddata.gz');
  if (fs.existsSync(localTraineddata)) {
    return { langPath: tessdataDir, cachePath: tessdataDir, gzip: true, offline: true };
  }
  if (!warnedOffline) {
    warnedOffline = true;
    console.warn('[captcha_ocr] 未找到本地语言包 tessdata/eng.traineddata.gz，将回退在线加载；服务器离线部署请先运行 npm run tessdata');
  }
  return { gzip: true, offline: false };
}

async function getWorker(config = {}) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    const tessdata = resolveTessdataOptions(config);
    const worker = await createWorker('eng', 1, {
      ...tessdata,
      logger: () => {},
      errorHandler: () => {},
    });
    await worker.setParameters({
      tessedit_char_whitelist: config.captchaWhitelist || DEFAULT_WHITELIST,
      tessedit_pageseg_mode: '7', // PSM.SINGLE_LINE
    });
    return worker;
  })();
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null; // 创建失败允许下次重建
    throw error;
  }
}

/** 识别原始文本（已预处理），返回 tesseract 输出字符串 */
async function recognize(buffer, config = {}) {
  const processed = preprocess(buffer, {
    scale: config.captchaScale,
    threshold: config.captchaThreshold,
    preprocess: config.captchaPreprocess,
  });
  const worker = await getWorker(config);
  try {
    const { data } = await worker.recognize(processed);
    return String(data?.text || '');
  } catch (error) {
    // worker 可能已损坏：销毁单例，下一次调用重建
    try { await worker.terminate(); } catch {}
    workerPromise = null;
    throw error;
  }
}

/** 识别并提取 4-6 位字母数字验证码，无法提取时返回 null */
async function recognizeCode(buffer, config = {}) {
  const text = await recognize(buffer, config);
  const match = text.replace(/[^0-9a-zA-Z]/g, '').match(CODE_PATTERN);
  return match ? match[0] : null;
}

/** 进程退出前释放 worker（可选） */
async function shutdown() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {}
  workerPromise = null;
}

module.exports = {
  recognize,
  recognizeCode,
  preprocess,
  shutdown,
  DEFAULT_THRESHOLD,
  DEFAULT_SCALE,
  DEFAULT_MODE,
  CODE_PATTERN,
};
