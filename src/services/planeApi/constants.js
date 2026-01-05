/**
 * Constants and configuration values for Plane API service
 */

// Rate limiting and retry configuration
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 1000;
export const REQUEST_TIMEOUT_MS = 45000;

// API limits
export const MAX_WORK_ITEMS_PER_PROJECT = 200;
export const MAX_ACTIVITIES_PER_ITEM = 20;
export const MAX_CONCURRENT_ACTIVITY_FETCHES = 5;
export const BATCH_DELAY_MS = 1000;
export const MAX_ITERATIONS = 10;

// Cache TTL settings (in milliseconds)
export const CACHE_TTL = {
  PROJECTS: 5 * 60 * 1000, // 5 minutes
  USERS: 30 * 60 * 1000, // 30 minutes
  WORK_ITEMS: 5 * 60 * 1000, // 5 minutes
  ACTIVITIES: 5 * 60 * 1000, // 5 minutes
  COMMENTS: 5 * 60 * 1000, // 5 minutes
  SUBITEMS: 5 * 60 * 1000, // 5 minutes
  CYCLES: 10 * 60 * 1000, // 10 minutes
};
