/**
 * Delays execution for the specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Makes a rate-limited GitHub API request with retry logic
 * Handles both primary and secondary rate limits with exponential backoff
 */
export async function rateLimitedRequest(
  requestFn: () => Promise<any>,
  retries: number = 3,
  baseDelay: number = 1000
): Promise<any> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await requestFn();
    } catch (error: any) {
      const isRateLimit = 
        error.status === 403 || 
        error.message?.toLowerCase().includes("rate limit") ||
        error.message?.toLowerCase().includes("secondary rate limit");

      if (isRateLimit && attempt < retries - 1) {
        // Calculate exponential backoff: 1s, 2s, 4s, etc.
        const waitTime = baseDelay * Math.pow(2, attempt);
        console.log(`Rate limit hit, waiting ${waitTime}ms before retry ${attempt + 1}/${retries}`);
        await delay(waitTime);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}

