/**
 * 令牌桶限速器（Token Bucket Rate Limiter）
 *
 * 职责：
 * - 以 requestsPerMinute 的稳态速率向调用方发放令牌；
 * - 允许 burst 大小的瞬时突发；
 * - 收到 429 后暂停整个令牌桶，进入冷却窗口（cooldownMs），防止各并发任务轮流打穿限流。
 *
 * 使用方式：
 *   const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10, cooldownMs: 60_000 });
 *   await limiter.acquire();   // 每次 HTTP 请求前调用
 *   limiter.onRateLimited();   // 收到 429 时调用
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;
  private pauseUntil = 0;
  private readonly cooldownMs: number;
  private readonly label: string;

  constructor(opts: {
    requestsPerMinute: number;
    burst: number;
    cooldownMs: number;
    label?: string;
  }) {
    this.maxTokens = opts.burst;
    this.tokens = opts.burst;
    this.refillRatePerMs = opts.requestsPerMinute / 60_000;
    this.lastRefill = Date.now();
    this.cooldownMs = opts.cooldownMs;
    this.label = opts.label ?? 'RateLimiter';
  }

  /**
   * 申请一个令牌。若令牌耗尽或处于冷却期则异步等待，直到可发出请求为止。
   * 所有 HTTP 请求在发送前必须先调用此方法。
   */
  async acquire(): Promise<void> {
    // 1. 若处于 429 冷却期，等到冷却结束
    const cooldownWait = this.pauseUntil - Date.now();
    if (cooldownWait > 0) {
      console.warn(
        `[${this.label}] 限流冷却中，等待 ${Math.ceil(cooldownWait / 1000)}s ` +
          `（恢复约 ${new Date(this.pauseUntil).toLocaleTimeString('zh-CN')}）`,
      );
      await delay(cooldownWait);
    }

    // 2. 按经过时间补充令牌
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;

    // 3. 有令牌立即发放
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }

    // 4. 令牌不足：等到补充够一个令牌
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    if (waitMs >= 1_500) {
      console.warn(
        `[${this.label}] 令牌不足，等待 ${Math.ceil(waitMs / 1000)}s` +
          `（稳态 ${Math.round(60_000 * this.refillRatePerMs)} req/min）`,
      );
    }
    await delay(waitMs);
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  /**
   * 服务端返回 429 时调用。
   * 将整个令牌桶暂停 cooldownMs（或 retryAfterMs 若服务端给出 Retry-After）。
   * 多个并发请求同时触发时，取最晚的 pauseUntil，不重置。
   */
  onRateLimited(retryAfterMs?: number): void {
    const pauseMs = retryAfterMs ?? this.cooldownMs;
    const until = Date.now() + pauseMs;
    if (until > this.pauseUntil) {
      this.pauseUntil = until;
      console.warn(
        `[${this.label}] 触发限流，暂停 ${Math.ceil(pauseMs / 1000)}s` +
          `（恢复约 ${new Date(this.pauseUntil).toLocaleTimeString('zh-CN')}）`,
      );
    }
    // 令牌清零，防止冷却结束后立即打满一批
    this.tokens = 0;
  }

  /** 当前是否处于冷却期（只读，供日志/监控使用） */
  get isCoolingDown(): boolean {
    return Date.now() < this.pauseUntil;
  }

  /** 距冷却结束的剩余毫秒数（已结束则为 0） */
  get cooldownRemainingMs(): number {
    return Math.max(0, this.pauseUntil - Date.now());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
