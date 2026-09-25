/**
 * 错误分类体系
 *
 * 将 EAMS 交互中可能出现的错误分为四类，以便监控循环按类型决定：
 *   - 是否计入失败计数
 *   - 是否触发告警
 *   - 是否重试
 *
 * 分类：
 *   TRANSPORT — 网络/连接失败（DNS 解析失败、超时、连接拒绝）
 *   AUTH      — 认证失败（登录被打回、验证码错误、会话过期无法恢复）
 *   SERVER    — 服务端故障（EAMS 返回 500 / 出错了 / Hibernate 异常）
 *   EMPTY     — 请求成功但无数据（确实没有成绩，非故障）
 */

const ErrorCode = Object.freeze({
  TRANSPORT: 'TRANSPORT',
  AUTH: 'AUTH',
  SERVER: 'SERVER',
  EMPTY: 'EMPTY',
});

/**
 * 基础错误类
 */
class EamsError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'EamsError';
    this.code = code;
    this.retryable = true;   // 默认可重试
    this.alert = false;      // 默认不告警
  }
}

class TransportError extends EamsError {
  constructor(message, options) {
    super(message, ErrorCode.TRANSPORT, options);
    this.name = 'TransportError';
  }
}

class AuthError extends EamsError {
  constructor(message, options) {
    super(message, ErrorCode.AUTH, options);
    this.name = 'AuthError';
  }
}

class ServerError extends EamsError {
  constructor(message, options) {
    super(message, ErrorCode.SERVER, options);
    this.name = 'ServerError';
    this.retryable = true;   // 服务端故障通常可重试
    this.alert = true;       // 服务端故障需要告警
  }
}

class EmptyDataError extends EamsError {
  constructor(message, options) {
    super(message, ErrorCode.EMPTY, options);
    this.name = 'EmptyDataError';
    this.retryable = false;  // 无数据不是故障，不应重试
    this.alert = false;
    this.failCount = false;  // 不计入失败计数
  }
}

/**
 * 错误分类器
 * 根据异常信息判断错误类型
 */
function classifyError(error) {
  const message = (error?.message || String(error)).toLowerCase();

  // SERVER: EAMS 500 / 出错了 / Hibernate / Spring
  if (message.includes('出错了') ||
      message.includes('error happened') ||
      message.includes('cannotcreate') ||
      message.includes('hibernate') ||
      message.includes('jdbc begin transaction') ||
      message.includes('org.springframework') ||
      (error?.response && error.response.status >= 500) ||
      (error?.status >= 500)) {
    return new ServerError(message, { cause: error });
  }

  // TRANSPORT: 网络/连接/超时
  if (message.includes('fetch failed') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('socket') ||
      message.includes('dns') ||
      message.includes('unable to resolve') ||
      message.includes('connect') ||
      message.includes('abort') ||
      error?.code === 'ECONNREFUSED' ||
      error?.code === 'ENOTFOUND' ||
      error?.code === 'ETIMEDOUT') {
    return new TransportError(message, { cause: error });
  }

  // AUTH: 登录被打回、验证码错误、会话问题
  if (message.includes('登录失败') ||
      message.includes('验证码') ||
      message.includes('session') ||
      message.includes('expired') ||
      message.includes('过期') ||
      message.includes('重复登录') ||
      message.includes('cas') ||
      message.includes('auth')) {
    return new AuthError(message, { cause: error });
  }

  // EMPTY: 明确无数据
  if (message.includes('未抓到成绩') ||
      message.includes('empty') ||
      message.includes('没有成绩') ||
      message.includes('no grades')) {
    return new EmptyDataError(message, { cause: error });
  }

  // 未知错误：默认按传输错误处理（保守，可重试）
  return new TransportError(message, { cause: error });
}

module.exports = {
  ErrorCode,
  EamsError,
  TransportError,
  AuthError,
  ServerError,
  EmptyDataError,
  classifyError,
};
