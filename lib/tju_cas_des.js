/**
 * 天津大学 CAS（sso.tju.edu.cn）登录用的 DES 加密。
 * 1:1 翻译自 tju-notify 的 utils/custom_des.py（原版是 Java CAS 的 strEnc 算法）。
 * 不依赖任何第三方加密库，纯位运算。
 *
 * 用法:
 *   const rsa = strEnc(用户名 + 密码 + lt, '1', '2', '3');
 */

const KEY_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const PC2 = [
  13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3,
  25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39,
  50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
];

const IP = [
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
  56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
  60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
];

const FP = [
  39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30,
  37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26,
  33, 1, 41, 9, 49, 17, 57, 25, 32, 0, 40, 8, 48, 16, 56, 24,
];

const E = [
  31, 0, 1, 2, 3, 4, 3, 4, 5, 6, 7, 8,
  7, 8, 9, 10, 11, 12, 11, 12, 13, 14, 15, 16,
  15, 16, 17, 18, 19, 20, 19, 20, 21, 22, 23, 24,
  23, 24, 25, 26, 27, 28, 27, 28, 29, 30, 31, 0,
];

const P = [
  15, 6, 19, 20, 28, 11, 27, 16,
  0, 14, 22, 25, 4, 17, 30, 9,
  1, 7, 23, 13, 31, 26, 2, 8,
  18, 12, 29, 5, 21, 10, 3, 24,
];

const S_BOXES = [
  [[14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
   [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
   [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
   [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13]],
  [[15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
   [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
   [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
   [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9]],
  [[10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
   [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
   [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
   [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12]],
  [[7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
   [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
   [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
   [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14]],
  [[2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
   [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
   [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
   [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3]],
  [[12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
   [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
   [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
   [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13]],
  [[4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
   [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
   [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
   [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12]],
  [[13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
   [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
   [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
   [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]],
];

const HEX2BIN = {};
const BIN2HEX = {};
for (let i = 0; i < 16; i++) {
  const hex = i.toString(16).toUpperCase();
  HEX2BIN[hex] = i.toString(2).padStart(4, '0');
  BIN2HEX[i.toString(2).padStart(4, '0')] = hex;
}

/** 字符串前 4 字符 -> 64 位数组（UTF-16，每字符 16 位，不足补 0） */
function strToBt(inputStr) {
  const s = inputStr.slice(0, 4);
  let bits = '';
  for (const ch of s) bits += ch.charCodeAt(0).toString(2).padStart(16, '0');
  return bits.padEnd(64, '0').split('').map(Number);
}

function bt64ToHex(byteData) {
  let out = '';
  for (let i = 0; i < 64; i += 4) {
    out += BIN2HEX[byteData[i] + '' + byteData[i + 1] + byteData[i + 2] + byteData[i + 3]];
  }
  return out;
}

function generateKeys(keyByte) {
  const key = new Array(56).fill(0);
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 8; j++) {
      key[i * 8 + j] = keyByte[8 * (7 - j) + i];
    }
  }
  const keys = [];
  for (const shift of KEY_SHIFTS) {
    for (let s = 0; s < shift; s++) {
      const tempLeft = key[0], tempRight = key[28];
      for (let k = 0; k < 27; k++) {
        key[k] = key[k + 1];
        key[28 + k] = key[29 + k];
      }
      key[27] = tempLeft;
      key[55] = tempRight;
    }
    keys.push(PC2.map(pos => key[pos]));
  }
  return keys;
}

function initPermute(original) {
  const out = new Array(64).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 7; j >= 0; j--) {
      out[i * 8 + 7 - j] = original[j * 8 + i * 2 + 1];
      out[i * 8 + 7 - j + 32] = original[j * 8 + i * 2];
    }
  }
  return out;
}

function expandPermute(right) {
  return E.map(i => right[i]);
}

function sBoxPermute(extended) {
  const out = new Array(32).fill(0);
  for (let m = 0; m < 8; m++) {
    const i = extended[m * 6] * 2 + extended[m * 6 + 5];
    const j = (extended[m * 6 + 1] << 3) | (extended[m * 6 + 2] << 2) |
             (extended[m * 6 + 3] << 1) | extended[m * 6 + 4];
    const val = S_BOXES[m][i][j];
    for (let n = 0; n < 4; n++) out[m * 4 + n] = (val >> (3 - n)) & 1;
  }
  return out;
}

function pPermute(sBoxOut) {
  return P.map(i => sBoxOut[i]);
}

function xor(a, b) {
  return a.map((x, i) => x ^ b[i]);
}

function desBlock(dataByte, keys) {
  const ipByte = initPermute(dataByte);
  let left = ipByte.slice(0, 32);
  let right = ipByte.slice(32);
  for (const key of keys) {
    const tempLeft = left;
    left = right;
    const f = pPermute(sBoxPermute(xor(expandPermute(right), key)));
    right = xor(f, tempLeft);
  }
  const final = right.concat(left);
  return FP.map(i => final[i]);
}

function enc(dataByte, keyByte) {
  return desBlock(dataByte, generateKeys(keyByte));
}

function getKeyBytes(key) {
  const keyBytes = [];
  const iterator = Math.floor(key.length / 4);
  for (let i = 0; i < iterator; i++) keyBytes.push(strToBt(key.slice(i * 4, i * 4 + 4)));
  if (key.length % 4 > 0) keyBytes.push(strToBt(key.slice(iterator * 4)));
  return keyBytes;
}

function applyKeys(block, keyBlocks) {
  let b = block;
  for (const kb of keyBlocks) b = enc(b, kb);
  return b;
}

/** 与 Python strEnc 完全等价的多轮 DES 加密 */
function strEnc(data, firstKey, secondKey, thirdKey) {
  if (!data) return '';
  const key1 = firstKey ? getKeyBytes(firstKey) : [];
  const key2 = secondKey ? getKeyBytes(secondKey) : [];
  const key3 = thirdKey ? getKeyBytes(thirdKey) : [];

  const blocks = [];
  const iterator = Math.floor(data.length / 4);
  for (let i = 0; i < iterator; i++) blocks.push(data.slice(i * 4, i * 4 + 4));
  if (data.length % 4 > 0) blocks.push(data.slice(iterator * 4));

  let out = '';
  for (const blockStr of blocks) {
    let bt = strToBt(blockStr);
    bt = applyKeys(bt, key1);
    bt = applyKeys(bt, key2);
    bt = applyKeys(bt, key3);
    out += bt64ToHex(bt);
  }
  return out;
}

module.exports = { strEnc };
