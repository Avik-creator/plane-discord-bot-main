/**
 * Cache management system for Plane API data
 * Handles caching with TTL and request deduplication
 */

import { CACHE_TTL } from "./constants.js";
import logger from "../../utils/logger.js";

/**
 * Cache entry structure
 * @typedef {Object} CacheEntry
 * @property {*} data - Cached data
 * @property {number} timestamp - When the data was cached
 */

/**
 * Generic cache manager for API responses
 */
class CacheManager {
  constructor(ttl = CACHE_TTL.PROJECTS) {
    this.cache = new Map();
    this.ttl = ttl;
    this.pendingRequests = new Map();
  }

  /**
   * Check if cache entry is still valid
   * @param {number} timestamp - Timestamp of cache entry
   * @returns {boolean} True if cache is still valid
   */
  isCacheValid(timestamp) {
    return timestamp && Date.now() - timestamp < this.ttl;
  }

  /**
   * Get cached data or null if expired/missing
   * @param {string} key - Cache key
   * @returns {*} Cached data or null
   */
  get(key) {
    const entry = this.cache.get(key);
    if (entry && this.isCacheValid(entry.timestamp)) {
      logger.info(`✓ Cache hit for key: ${key}`);
      return entry.data;
    }
    if (entry) {
      this.cache.delete(key);
      logger.info(`✓ Cache expired for key: ${key}`);
    }
    return null;
  }

  /**
   * Set cache data
   * @param {string} key - Cache key
   * @param {*} data - Data to cache
   */
  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
    logger.info(`📦 Cached data for key: ${key}`);
  }

  /**
   * Get or fetch data with deduplication
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Async function to fetch data if not cached
   * @returns {Promise<*>} Cached or fetched data
   */
  async getOrFetch(key, fetchFn) {
    // Check cache first
    const cached = this.get(key);
    if (cached !== null) {
      return cached;
    }

    // Deduplicate: return existing request promise if in progress
    if (this.pendingRequests.has(key)) {
      logger.info(`⏳ Waiting for in-flight request for key: ${key}`);
      return this.pendingRequests.get(key);
    }

    // Create new request
    const requestPromise = (async () => {
      try {
        logger.info(`📡 Fetching fresh data for key: ${key}`);
        const data = await fetchFn();
        this.set(key, data);
        return data;
      } finally {
        this.pendingRequests.delete(key);
      }
    })();

    this.pendingRequests.set(key, requestPromise);
    return requestPromise;
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
    this.pendingRequests.clear();
    logger.info("Cache cleared");
  }

  /**
   * Clear specific cache key
   * @param {string} key - Cache key to clear
   */
  clearKey(key) {
    this.cache.delete(key);
    logger.info(`Cache cleared for key: ${key}`);
  }
}

// Export cache managers for different data types
export const projectsCache = new CacheManager(CACHE_TTL.PROJECTS);
export const usersCache = new CacheManager(CACHE_TTL.USERS);
export const workItemsCache = new CacheManager(CACHE_TTL.WORK_ITEMS);
export const activitiesCache = new CacheManager(CACHE_TTL.ACTIVITIES);
export const commentsCache = new CacheManager(CACHE_TTL.COMMENTS);
export const subitemsCache = new CacheManager(CACHE_TTL.SUBITEMS);
export const cyclesCache = new CacheManager(CACHE_TTL.CYCLES);

/**
 * Clear all activity-related caches to ensure fresh data
 */
export function clearActivityCaches() {
  activitiesCache.clear();
  commentsCache.clear();
  subitemsCache.clear();
  logger.debug('Cleared activity caches for fresh data fetch');
}

/**
 * Clear all caches
 */
export function clearAllCaches() {
  projectsCache.clear();
  usersCache.clear();
  workItemsCache.clear();
  activitiesCache.clear();
  commentsCache.clear();
  subitemsCache.clear();
  cyclesCache.clear();
  logger.info('All caches cleared');
}
