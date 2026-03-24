import type { RetryConfig, OutboundSendResult } from "./types.js";
import { isRetryableTransportError } from "./transport-fallback.js";

type LogFn = (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void;

/**
 * Determine whether an error or failed result is retryable.
 * Delegates to isRetryableTransportError for comprehensive transport-level error classification.
 */
export function isRetryable(errorOrResult: unknown): boolean {
  if (
    errorOrResult &&
    typeof errorOrResult === "object" &&
    "ok" in errorOrResult &&
    "statusCode" in errorOrResult
  ) {
    const result = errorOrResult as OutboundSendResult;
    if (result.ok) return false;
    return isRetryableTransportError(result);
  }

  return isRetryableTransportError(errorOrResult);
}

/**
 * Calculate delay with exponential backoff + jitter.
 */
function calcDelay(attempt: number, config: RetryConfig): number {
  const exponential = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  // Add 0–10% jitter to prevent thundering herd
  const jitter = Math.random() * exponential * 0.1;
  return exponential + jitter;
}

/**
 * Wrap an async operation with configurable retry + exponential backoff.
 *
 * The function `fn` should throw on network errors or return an
 * OutboundSendResult. Non-retryable failures are returned immediately.
 */
export async function withRetry(
  fn: () => Promise<OutboundSendResult>,
  config: RetryConfig,
  log?: LogFn,
  peerName?: string,
): Promise<OutboundSendResult> {
  let lastResult: OutboundSendResult | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();

      // Success → return immediately
      if (result.ok) return result;

      // Non-retryable failure → return immediately
      if (!isRetryable(result)) return result;

      lastResult = result;
    } catch (error: unknown) {
      if (!isRetryable(error)) {
        return {
          ok: false,
          statusCode: 500,
          response: { error: error instanceof Error ? error.message : String(error) },
        };
      }

      lastResult = {
        ok: false,
        statusCode: 500,
        response: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    // If we have retries left, wait before the next attempt
    if (attempt < config.maxRetries) {
      const delay = calcDelay(attempt, config);
      log?.("warn", "peer.retry", {
        peer: peerName,
        attempt: attempt + 1,
        max_retries: config.maxRetries,
        delay_ms: Math.round(delay),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted
  return lastResult!;
}
