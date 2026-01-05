/**
 * API request handling with retry logic and error handling
 */

import logger from "../../utils/logger.js";
import { getApiClient, getServiceConfig } from "./apiClient.js";
import { MAX_RETRIES, INITIAL_RETRY_DELAY_MS } from "./constants.js";
import { sleep } from "./helpers.js";

/**
 * Make API request with exponential backoff retry on 429 errors only
 * @param {Function} requestFn - Async function that makes the API request
 * @param {string} context - Description of the request for logging
 * @returns {Promise<Object>} API response
 * @throws {Error} If request fails after retries or on non-429 errors
 */
export async function apiRequestWithRetry(requestFn, context = "") {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await requestFn();
      logger.info(`✓ ${context} succeeded`);
      return result;
    } catch (error) {
      lastError = error;

      if (error.response?.status === 429) {
        const retryAfter = error.response.headers["retry-after"];
        const delayMs = retryAfter
          ? parseInt(retryAfter) * 1000
          : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

        logger.warn(
          `[429 Rate Limited] ${context}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms | Headers: ${JSON.stringify(
            error.response.headers
          )}`
        );
        await sleep(delayMs);
      } else {
        // Non-429 errors: fail immediately, don't retry
        logger.error(
          `[${error.response?.status || "Network"}] ${context}: ${error.message}`
        );
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Make GET request to Plane API
 * @param {string} endpoint - API endpoint path
 * @param {Object} params - Query parameters
 * @param {string} context - Description for logging
 * @returns {Promise<Object>} API response
 */
export async function apiGet(endpoint, params = {}, context = "") {
  const api = getApiClient();
  return apiRequestWithRetry(
    () => api.get(endpoint, { params }),
    context
  );
}

/**
 * Simple concurrency limiter for parallel operations
 */
export class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  /**
   * Run function with concurrency limit
   * @param {Function} fn - Async function to run
   * @returns {Promise<*>} Function result
   */
  async run(fn) {
    while (this.running >= this.maxConcurrent) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const resolve = this.queue.shift();
      if (resolve) resolve();
    }
  }
}
