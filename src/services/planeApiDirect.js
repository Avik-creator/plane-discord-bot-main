/**
 * Plane API Direct Service - Main Export
 * 
 * This module provides a modular interface to the Plane project management API.
 * It separates concerns into different modules:
 * 
 * - apiClient: API initialization and client management
 * - constants: Configuration constants and TTL values
 * - cacheManager: Cache management with TTL and deduplication
 * - helpers: Utility functions for data processing
 * - apiRequest: API request handling with retry logic
 * - dataFetchers: Individual data fetching functions
 * - teamActivities: Team-wide activity aggregation
 * 
 * Example usage:
 * ```
 * import { initPlaneService, getTeamActivities } from './planeApiDirect.js';
 * 
 * initPlaneService(config);
 * const activities = await getTeamActivities(startDate, endDate);
 * ```
 */

// API Client and Initialization
export { initPlaneService, ensureApi, getApiClient, getServiceConfig } from "./planeApi/apiClient.js";

// Cache Management
export {
  projectsCache,
  usersCache,
  workItemsCache,
  activitiesCache,
  commentsCache,
  subitemsCache,
  cyclesCache,
  clearActivityCaches,
  clearAllCaches,
} from "./planeApi/cacheManager.js";

// Utility Helpers
export {
  sleep,
  normalizeName,
  namesMatch,
  getNextCursor,
  getResults,
  getWorkItemState,
  getWorkItemPriority,
  getAssigneeNames,
  classifyWorkItemState,
  calculateCompletionPercentage,
  isDateInRange,
  getCommentText,
  getActorId,
} from "./planeApi/helpers.js";

// API Request Handling
export { apiRequestWithRetry, apiGet, ConcurrencyLimiter } from "./planeApi/apiRequest.js";

// Data Fetchers
export {
  // Projects
  fetchProjects,
  getProjectsWithCache,
  // Work Items
  fetchWorkItems,
  getWorkItemsWithCache,
  // Activities
  fetchWorkItemActivities,
  getActivitiesWithCache,
  // Comments
  fetchWorkItemComments,
  getCommentsWithCache,
  // Subitems
  fetchWorkItemSubitems,
  getSubitemsWithCache,
  // Cycles
  fetchCycles,
  getCyclesWithCache,
  // Workspace
  getWorkspaceMembers,
  fetchUserName,
  getWorkspaceDetails,
  getWorkspaceActivities,
} from "./planeApi/dataFetchers.js";

// Team Activities
export {
  getTeamActivities,
  getWorkItemsSnapshot,
} from "./planeApi/teamActivities.js";
