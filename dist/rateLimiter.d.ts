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
export declare class RateLimiter {
    private tokens;
    private readonly maxTokens;
    private readonly refillRatePerMs;
    private lastRefill;
    private pauseUntil;
    private readonly cooldownMs;
    private readonly label;
    constructor(opts: {
        requestsPerMinute: number;
        burst: number;
        cooldownMs: number;
        label?: string;
    });
    /**
     * 申请一个令牌。若令牌耗尽或处于冷却期则异步等待，直到可发出请求为止。
     * 所有 HTTP 请求在发送前必须先调用此方法。
     */
    acquire(): Promise<void>;
    /**
     * 服务端返回 429 时调用。
     * 将整个令牌桶暂停 cooldownMs（或 retryAfterMs 若服务端给出 Retry-After）。
     * 多个并发请求同时触发时，取最晚的 pauseUntil，不重置。
     */
    onRateLimited(retryAfterMs?: number): void;
    /** 当前是否处于冷却期（只读，供日志/监控使用） */
    get isCoolingDown(): boolean;
    /** 距冷却结束的剩余毫秒数（已结束则为 0） */
    get cooldownRemainingMs(): number;
}
//# sourceMappingURL=rateLimiter.d.ts.map