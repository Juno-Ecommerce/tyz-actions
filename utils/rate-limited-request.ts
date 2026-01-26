/**
 * Rate-limited wrapper for GitHub API requests with exponential backoff retry logic
 * Handles secondary rate limits and standard rate limits gracefully
 */

interface RateLimitError extends Error {
  status?: number;
  response?: {
    headers?: {
      'x-ratelimit-remaining'?: string;
      'x-ratelimit-reset'?: string;
      'retry-after'?: string;
    };
  };
}

const isRateLimitError = (error: any): boolean => {
  if (!error) return false;

  // Check for secondary rate limit (status 403 or 429 with specific message)
  // GitHub docs: "If you exceed a secondary rate limit, you will receive a 403 or 429 response
  // and an error message that indicates that you exceeded a secondary rate limit"
  const errorMessage = (error.message || '').toLowerCase();
  const isSecondaryRateLimit = errorMessage.includes('secondary rate limit') ||
                                errorMessage.includes('abuse detection') ||
                                errorMessage.includes('rate limit exceeded');
  
  if ((error.status === 403 || error.status === 429) && isSecondaryRateLimit) {
    return true;
  }

  // Check for primary rate limit (status 403 with rate limit headers)
  // GitHub docs: "If you exceed your primary rate limit, you will receive a 403 or 429 response,
  // and the x-ratelimit-remaining header will be 0"
  if ((error.status === 403 || error.status === 429) && 
      error.response?.headers?.['x-ratelimit-remaining'] === '0') {
    return true;
  }

  return false;
};

const isSecondaryRateLimitError = (error: any): boolean => {
  if (!error) return false;
  
  const errorMessage = (error.message || '').toLowerCase();
  return (error.status === 403 || error.status === 429) && (
    errorMessage.includes('secondary rate limit') ||
    errorMessage.includes('abuse detection') ||
    errorMessage.includes('rate limit exceeded')
  );
};

const getRetryAfter = (error: any): number | null => {
  // Check for Retry-After header (in seconds)
  const retryAfter = error.response?.headers?.['retry-after'];
  if (retryAfter) {
    return parseInt(retryAfter, 10) * 1000; // Convert to milliseconds
  }

  // Check for X-RateLimit-Reset header
  const resetTime = error.response?.headers?.['x-ratelimit-reset'];
  if (resetTime) {
    const resetTimestamp = parseInt(resetTime, 10) * 1000; // Convert to milliseconds
    const now = Date.now();
    const waitTime = resetTimestamp - now;
    if (waitTime > 0) {
      return waitTime;
    }
  }

  return null;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Makes a rate-limited GitHub API request with automatic retry and exponential backoff
 *
 * @param octokit - The Octokit instance
 * @param requestFn - Function that returns the API request promise
 * @param options - Configuration options
 * @returns The API response
 */
export async function rateLimitedRequest<T = any>(
  requestFn: () => Promise<{ data: T }>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    owner?: string;
    repo?: string;
    operation?: string;
  } = {}
): Promise<{ data: T }> {
  const {
    maxRetries = 5,
    baseDelay = 1000, // 1 second
    maxDelay = 60000, // 60 seconds
    owner,
    repo,
    operation = 'API request'
  } = options;

  let lastError: any;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      // Add a small delay between requests to avoid hitting secondary rate limits
      // This helps prevent "too many requests in a short time" errors
      if (attempt > 0) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const logPrefix = owner && repo ? `[${owner}/${repo}]` : '';
        console.log(`${logPrefix} Retrying ${operation} (attempt ${attempt + 1}/${maxRetries + 1}) after ${delay}ms delay`);
        await sleep(delay);
      } else if (attempt === 0) {
        // Small delay even on first attempt to space out requests
        // Helps prevent hitting secondary rate limits from too many requests in short time
        // Reduced from 100ms to 50ms to improve performance while still being safe
        await sleep(50); // 50ms delay between requests
      }

      const response = await requestFn();
      return response;
    } catch (error: any) {
      lastError = error;

      // Check if it's a rate limit error
      if (isRateLimitError(error)) {
        const retryAfter = getRetryAfter(error);
        const isSecondary = isSecondaryRateLimitError(error);
        const logPrefix = owner && repo ? `[${owner}/${repo}]` : '';
        const rateLimitType = isSecondary ? 'secondary' : 'primary';

        if (retryAfter && retryAfter > 0) {
          // GitHub docs: "If the retry-after response header is present, you should not retry
          // your request until after that many seconds has elapsed"
          console.warn(
            `${logPrefix} ${rateLimitType.charAt(0).toUpperCase() + rateLimitType.slice(1)} rate limit hit for ${operation}. Waiting ${Math.round(retryAfter / 1000)}s (server-suggested) before retry...`
          );
          await sleep(retryAfter);
        } else if (attempt < maxRetries) {
          // GitHub docs: "If the x-ratelimit-remaining header is 0, you should not retry your request
          // until after the time, in UTC epoch seconds, specified by the x-ratelimit-reset header.
          // Otherwise, wait for at least one minute before retrying."
          // For secondary rate limits without headers: "wait for at least one minute before retrying"
          const minWaitTime = isSecondary ? 60000 : baseDelay; // 60 seconds for secondary, 1 second for primary
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
          const delay = Math.max(minWaitTime, exponentialDelay);
          
          console.warn(
            `${logPrefix} ${rateLimitType.charAt(0).toUpperCase() + rateLimitType.slice(1)} rate limit hit for ${operation}. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries + 1})...`
          );
          await sleep(delay);
        } else {
          // Max retries exceeded
          // GitHub docs: "throw an error after a specific number of retries"
          console.error(
            `${logPrefix} ${rateLimitType.charAt(0).toUpperCase() + rateLimitType.slice(1)} rate limit exceeded for ${operation} after ${maxRetries + 1} attempts. Giving up.`
          );
          throw error;
        }
      } else {
        // Not a rate limit error, throw immediately
        throw error;
      }
    }

    attempt++;
  }

  // Should never reach here, but TypeScript needs this
  throw lastError;
}

/**
 * Batch processes items with rate limiting and delays between batches
 * 
 * GitHub secondary rate limits:
 * - No more than 100 concurrent requests
 * - No more than 900 points per minute for REST API (GET=1pt, POST/PATCH/DELETE=5pts)
 * - No more than 80 content-generating requests per minute
 * - No more than 500 content-generating requests per hour
 * 
 * This function processes items sequentially (not concurrently) to stay within limits.
 *
 * @param items - Array of items to process
 * @param processor - Function that processes each item
 * @param options - Configuration options
 */
export async function batchProcess<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options: {
    batchSize?: number;
    delayBetweenBatches?: number;
    delayBetweenItems?: number;
    owner?: string;
    repo?: string;
  } = {}
): Promise<R[]> {
  const {
    batchSize = 10,
    delayBetweenBatches = 500, // 500ms between batches (balanced for write operations - 5pts each)
    delayBetweenItems = 75, // 75ms between items (helps stay under 80 requests/min for content creation)
    owner,
    repo
  } = options;

  const results: R[] = [];
  const logPrefix = owner && repo ? `[${owner}/${repo}]` : '';

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);

    if (totalBatches > 1) {
      console.log(`${logPrefix} Processing batch ${batchNum}/${totalBatches} (${batch.length} items)`);
    }

    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const index = i + j;

      try {
        const result = await processor(item, index);
        results.push(result);

        // Small delay between items to avoid hitting rate limits
        if (j < batch.length - 1) {
          await sleep(delayBetweenItems);
        }
      } catch (error: any) {
        console.error(`${logPrefix} Error processing item ${index + 1}:`, error.message);
        throw error; // Re-throw to stop processing
      }
    }

    // Delay between batches (except after the last batch)
    if (i + batchSize < items.length) {
      await sleep(delayBetweenBatches);
    }
  }

  return results;
}
