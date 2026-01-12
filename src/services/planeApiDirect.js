import axios from "axios";
import logger from "../utils/logger.js";

// Initialized configuration
let serviceConfig = null;
let PLANE_API = null;

// Rate limiting and constants
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 20000; // 20 seconds
const MAX_WORK_ITEMS_PER_PROJECT = 200;
const MAX_ACTIVITIES_PER_ITEM = 20;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_CONCURRENT_ACTIVITY_FETCHES = 5; // Increased from 2 for better throughput
const MAX_CONCURRENT_PROJECT_FETCHES = 3; // Parallel project processing
const BATCH_DELAY_MS = 500; // Reduced from 20000ms - rate limiter handles 429s
const PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache projects for 5 minutes
const USERS_CACHE_TTL_MS = 30 * 60 * 1000; // Cache users for 30 minutes
const PROJECT_MEMBERS_CACHE_TTL_MS = 10 * 60 * 1000; // Cache project members for 10 minutes

/**
 * Initialize the Plane service with configuration
 * @param {Object} config - Configuration object
 */
function initPlaneService(config) {
  serviceConfig = config;
  PLANE_API = axios.create({
    baseURL: serviceConfig.PLANE_BASE_URL,
    headers: {
      "X-API-KEY": serviceConfig.PLANE_API_KEY,
      "Content-Type": "application/json",
    },
    timeout: REQUEST_TIMEOUT_MS,
  });
  logger.info("Plane service initialized");
}

/**
 * Ensures the API client is initialized. Defaults to enhanced config if available.
 */
function ensureApi() {
  if (!PLANE_API) {
    throw new Error("Plane API service not initialized. Call initPlaneService(config) first.");
  }
}

// Cache
let projectsCache = null;
let projectsCacheTime = null;
let workspaceDetailsCache = null;
let usersCache = new Map(); // Map of userId -> user details
let usersCacheTime = null; // Track when users were last fully fetched
let allUsersLoaded = false; // Flag to track if we've loaded all users

// Project members cache: Map of projectId -> { data: members[], timestamp: number }
let projectMembersCache = new Map();

// Work items cache: Map of projectId -> { data: items[], timestamp: number, sessionId: string }
const WORK_ITEMS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes per session
let workItemsCache = new Map();

// Activities cache: Map of workItemId -> { data: activities[], timestamp: number, sessionId: string }
const ACTIVITIES_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes per session
let activitiesCache = new Map();

// Comments cache: Map of workItemId -> { data: comments[], timestamp: number, sessionId: string }
const COMMENTS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes per session
let commentsCache = new Map();

// Subitems cache: Map of workItemId -> { data: subitems[], timestamp: number, sessionId: string }
const SUBITEMS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes per session
let subitemsCache = new Map();

// Cycles cache: Map of projectId -> { data: cycles[], timestamp: number, sessionId: string }
const CYCLES_CACHE_TTL_MS = 5 * 60 * 1000; // Cache for 5 minutes per session
let cyclesCache = new Map();

// Session tracking for per-project caching
let currentSessionId = null;
let sessionStartTime = null;

// Request deduplication: Map of key -> Promise to avoid duplicate API calls
const pendingRequests = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a name for comparison by removing special characters, converting to lowercase
 * Handles variations like "shruti.dhasmana" vs "Shruti Dhasmana"
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[.\-_\s]+/g, '');
}

/**
 * Check if two names match (handles different formats)
 * e.g., "shruti.dhasmana" matches "Shruti Dhasmana"
 */
function namesMatch(name1, name2) {
  if (!name1 || !name2) return false;
  return normalizeName(name1) === normalizeName(name2);
}

/**
 * Check if cache entry is still valid
 */
function isCacheValid(timestamp, ttl) {
  return timestamp && Date.now() - timestamp < ttl;
}

/**
 * Start a new caching session for a project
 * This ensures fresh data is fetched for the first request in a session,
 * then cached for subsequent requests within the same session
 * @param {string} projectId - Project ID to start session for
 */
function startProjectSession(projectId) {
  const sessionId = `${projectId}_${Date.now()}`;
  currentSessionId = sessionId;
  sessionStartTime = Date.now();
  logger.debug(`🔄 Started new cache session: ${sessionId}`);
  return sessionId;
}

/**
 * Check if cache entry belongs to current session
 */
function isInCurrentSession(cacheEntry) {
  if (!currentSessionId || !cacheEntry) return false;
  return cacheEntry.sessionId === currentSessionId;
}

/**
 * Clear caches for a specific project (useful between different operations)
 */
function clearProjectCache(projectId) {
  workItemsCache.delete(projectId);
  logger.debug(`🗑️ Cleared cache for project ${projectId}`);
}

/**
 * Get projects from cache or fetch
 */
async function getProjectsWithCache() {
  const now = Date.now();
  if (
    projectsCache &&
    projectsCacheTime &&
    now - projectsCacheTime < PROJECTS_CACHE_TTL_MS
  ) {
    logger.info("Using cached projects");
    return projectsCache;
  }

  const projects = await fetchProjects();
  projectsCache = projects;
  projectsCacheTime = now;
  return projects;
}

/**
 * Fetch comments for a work item
 */
async function fetchWorkItemComments(projectId, workItemId) {
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/comments/`
        ),
      `comments(${workItemId})`
    );
    return Array.isArray(response.data)
      ? response.data
      : response.data.results || [];
  } catch (error) {
    logger.warn(`Failed to fetch comments for ${workItemId}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch subitems for a work item
 */
async function fetchWorkItemSubitems(projectId, workItemId) {
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/sub-issues/`,
          { params: { expand: "state" } }
        ),
      `subitems(${workItemId})`
    );
    return Array.isArray(response.data)
      ? response.data
      : response.data.results || [];
  } catch (error) {
    logger.warn(`Failed to fetch subitems for ${workItemId}: ${error.message}`);
    return [];
  }
}

/**
 * Preload all workspace members into cache for fast lookup
 * Call this once at the start of processing to avoid repeated API calls
 */
async function preloadAllUsers() {
  ensureApi();

  // Skip if already loaded recently
  if (allUsersLoaded && usersCacheTime && isCacheValid(usersCacheTime, USERS_CACHE_TTL_MS)) {
    logger.info(`✓ Users already preloaded (${usersCache.size} cached)`);
    return;
  }

  try {
    logger.info("📡 Preloading all workspace members...");
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${serviceConfig.WORKSPACE_SLUG}/members/`, {
          params: { page: 1, per_page: 100 },
        }),
      `preloadAllUsers`
    );

    const members = response.data.results || response.data || [];

    // Cache all users by their various IDs
    for (const member of members) {
      const userData = member.member || member.user || member;
      const userName =
        member.display_name ||
        userData.display_name ||
        userData.first_name ||
        userData.email ||
        userData.id;

      // Cache by all possible IDs
      if (member.id) usersCache.set(member.id, userName);
      if (member.member_id) usersCache.set(member.member_id, userName);
      if (userData.id && userData.id !== member.id) usersCache.set(userData.id, userName);
    }

    usersCacheTime = Date.now();
    allUsersLoaded = true;
    logger.info(`✓ Preloaded ${members.length} users into cache`);
  } catch (error) {
    logger.warn(`Failed to preload users: ${error.message}`);
  }
}

/**
 * Fetch user details by ID from cache (preload first!)
 */
async function fetchUserName(userId) {
  ensureApi();

  // Return from cache if available
  if (usersCache.has(userId)) {
    return usersCache.get(userId);
  }

  // If not in cache and we haven't preloaded, preload now
  if (!allUsersLoaded) {
    await preloadAllUsers();
    if (usersCache.has(userId)) {
      return usersCache.get(userId);
    }
  }

  // Still not found, return the ID
  return userId;
}

/**
 * Fetch all workspace members
 */
async function getWorkspaceMembers() {
  ensureApi();
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${serviceConfig.WORKSPACE_SLUG}/members/`, {
          params: { page: 1, per_page: 100 },
        }),
      `getWorkspaceMembers`
    );

    return response.data.results || response.data || [];
  } catch (error) {
    logger.error(`Failed to fetch workspace members: ${error.message}`);
    return [];
  }
}

/**
 * Fetch members assigned to a specific project with caching
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of project members
 */
async function getProjectMembers(projectId) {
  ensureApi();

  // Check cache first
  const cacheEntry = projectMembersCache.get(projectId);
  if (cacheEntry && isCacheValid(cacheEntry.timestamp, PROJECT_MEMBERS_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached project members for ${projectId}`);
    return cacheEntry.data;
  }

  // Check for pending request
  const cacheKey = `projectMembers:${projectId}`;
  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight project members request for ${projectId}`);
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const response = await apiRequestWithRetry(
        () =>
          PLANE_API.get(
            `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/members/`,
            { params: { page: 1, per_page: 100 } }
          ),
        `getProjectMembers(${projectId})`
      );

      const members = response.data.results || response.data || [];

      // Cache the result
      projectMembersCache.set(projectId, {
        data: members,
        timestamp: Date.now(),
      });

      return members;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Extract member IDs from project members response
 */
function extractMemberIds(members) {
  const memberIds = new Set();
  const memberNames = new Map(); // id -> name for quick lookup

  for (const member of members) {
    const userData = member.member || member.user || member;
    const memberId = member.member_id || userData.id || member.id;
    const memberName =
      member.display_name ||
      userData.display_name ||
      userData.first_name ||
      userData.email ||
      memberId;

    if (memberId) {
      memberIds.add(memberId);
      memberNames.set(memberId, memberName);
      // Also cache in users cache
      usersCache.set(memberId, memberName);
    }
  }

  return { memberIds, memberNames };
}

/**
 * Check if a work item is relevant to project members
 * A work item is relevant if it's:
 * 1. Assigned to any project member, OR
 * 2. Created by a project member, OR
 * 3. Updated by a project member
 */
function isRelevantToMembers(workItem, memberIds) {
  // Check assignees array
  if (workItem.assignees && Array.isArray(workItem.assignees)) {
    for (const assigneeId of workItem.assignees) {
      if (memberIds.has(assigneeId)) return true;
    }
  }

  // Check assignee_details array
  if (workItem.assignee_details && Array.isArray(workItem.assignee_details)) {
    for (const assignee of workItem.assignee_details) {
      if (memberIds.has(assignee.id)) return true;
    }
  }

  // Check if created by a project member
  if (workItem.created_by && memberIds.has(workItem.created_by)) {
    return true;
  }

  // Check if updated by a project member
  if (workItem.updated_by && memberIds.has(workItem.updated_by)) {
    return true;
  }

  return false;
}

/**
 * Fetch workspace details
 */
async function getWorkspaceDetails() {
  ensureApi();
  if (workspaceDetailsCache) return workspaceDetailsCache;

  try {
    const response = await apiRequestWithRetry(
      () => PLANE_API.get(`/workspaces/${serviceConfig.WORKSPACE_SLUG}`),
      `getWorkspaceDetails`
    );

    workspaceDetailsCache = response.data;
    return workspaceDetailsCache;
  } catch (error) {
    logger.error(`Failed to fetch workspace details: ${error.message}`);
    return { name: serviceConfig.WORKSPACE_SLUG, slug: serviceConfig.WORKSPACE_SLUG };
  }
}

/**
 * Fetch workspace-wide activities with filtering
 * @param {Object} params - Query parameters (actor, created_at__gte, etc.)
 */
async function getWorkspaceActivities(params) {
  ensureApi();
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${serviceConfig.WORKSPACE_SLUG}/activities/`, {
          params,
        }),
      `getWorkspaceActivities`
    );

    return response.data.results || response.data || [];
  } catch (error) {
    logger.error(`Failed to fetch workspace activities: ${error.message}`);
    return [];
  }
}

/**
 * Simple concurrency limiter
 */
class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

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

/**
 * Make API request with exponential backoff - ONLY on 429
 */
async function apiRequestWithRetry(requestFn, context = "") {
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await requestFn();
      logger.debug(`✓ ${context} succeeded`);
      return result;
    } catch (error) {
      lastError = error;

      if (error.response?.status === 429) {
        const retryAfter = error.response.headers["retry-after"];
        const baseDelay = retryAfter
          ? parseInt(retryAfter) * 1000
          : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

        // Add extra delay for more conservative rate limiting
        const delayMs = Math.max(baseDelay, 3000 + (attempt * 2000));

        logger.warn(
          `[429 Rate Limited] ${context}, retry ${attempt + 1
          }/${MAX_RETRIES} in ${delayMs}ms | Headers: ${JSON.stringify(
            error.response.headers
          )}`
        );
        await sleep(delayMs);
      } else {
        // Non-429 errors: fail immediately, don't retry
        logger.error(
          `[${error.response?.status || "Network"}] ${context}: ${error.message
          }`
        );
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Fetch all projects in the workspace
 */
async function fetchProjects() {
  ensureApi();
  // Return cached projects if available and not expired
  if (
    projectsCache &&
    projectsCacheTime &&
    Date.now() - projectsCacheTime < PROJECTS_CACHE_TTL_MS
  ) {
    return projectsCache;
  }

  const projects = [];
  let cursor = null;
  let hasMore = true;
  let iteration = 0;

  while (hasMore) {
    iteration++;
    if (iteration > 20) { // Same safety break
      logger.warn(`Too many fetchProjects iterations, breaking`);
      break;
    }

    const params = cursor ? { cursor } : {};
    logger.debug(
      `Fetching projects ${cursor ? `(cursor: ${cursor})` : `(page ${iteration})`}`
    );
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/`, {
          params,
        }),
      "fetchProjects"
    );

    const data = response.data;
    logger.info(
      `Projects API response: ${JSON.stringify({
        isArray: Array.isArray(data),
        hasResults: !!data.results,
        resultsCount: Array.isArray(data.results) ? data.results.length : 0,
        hasCursor: !!data.next_cursor,
      })}`
    );

    if (Array.isArray(data)) {
      // Direct array response
      projects.push(...data);
      hasMore = false;
    } else if (Array.isArray(data.results) && data.results.length > 0) {
      // Paginated results response - this is what Plane actually returns
      projects.push(...data.results);
      cursor = data.next_cursor;
      hasMore = !!cursor;
    } else if (data.grouped_by && Object.keys(data.grouped_by).length > 0) {
      // Grouped response - extract from groups
      for (const group of Object.values(data.grouped_by)) {
        if (Array.isArray(group)) {
          projects.push(...group);
        }
      }
      cursor = data.next_cursor;
      hasMore = !!cursor;
    } else {
      hasMore = false;
    }
  }

  logger.info(
    `Fetched ${projects.length} projects total after ${iteration} iterations`
  );

  // Cache the results
  projectsCache = projects;
  projectsCacheTime = Date.now();

  return projects;
}

/**
 * Fetch all work items from a project
 */
async function fetchWorkItems(projectId) {
  ensureApi();
  const workItems = [];
  let cursor = null;
  let hasMore = true;
  let iteration = 0;
  const MAX_ITERATIONS = 10; // Safety limit to prevent infinite loops

  while (hasMore && workItems.length < MAX_WORK_ITEMS_PER_PROJECT && iteration < MAX_ITERATIONS) {
    iteration++;
    const params = {
      order_by: "-updated_at", // Fetch most recently updated first
      expand: "state", // Expand state details to get full state information
      ...(cursor ? { cursor } : {}),
    };
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/work-items/`,
          { params }
        ),
      `fetchWorkItems(${projectId})`
    );

    const data = response.data;
    const resultsCount = Array.isArray(data) ? data.length : data.results?.length || 0;

    logger.debug(
      `Work items API response: ${JSON.stringify({
        isArray: Array.isArray(data),
        hasResults: !!data.results,
        count: resultsCount,
        iteration,
      })}`
    );

    if (Array.isArray(data)) {
      workItems.push(
        ...data.slice(0, MAX_WORK_ITEMS_PER_PROJECT - workItems.length)
      );
      hasMore = false;
    } else if (data.results && data.results.length > 0) {
      // Only continue if we actually got results
      workItems.push(
        ...data.results.slice(0, MAX_WORK_ITEMS_PER_PROJECT - workItems.length)
      );
      cursor =
        data.next_cursor && workItems.length < MAX_WORK_ITEMS_PER_PROJECT
          ? data.next_cursor
          : null;
      hasMore = !!cursor;
    } else {
      // Empty results or no results - stop pagination
      hasMore = false;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    logger.warn(`fetchWorkItems hit max iterations (${MAX_ITERATIONS}) for project ${projectId}`);
  }

  logger.info(`Fetched ${workItems.length} work items for project ${projectId} in ${iteration} iterations`);
  return workItems;
}

/**
 * Fetch activities for a work item
 */
async function fetchWorkItemActivities(projectId, workItemId) {
  ensureApi();
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/activities/`
        ),
      `activities(${workItemId})`
    );
    return Array.isArray(response.data)
      ? response.data
      : response.data.results || [];
  } catch (error) {
    logger.warn(
      `Failed to fetch activities for ${workItemId}: ${error.message}`
    );
    return [];
  }
}

/**
 * Extract current relationships from work item activities
 * Relationships in Plane are stored as activity history, not as current fields
 */
async function fetchWorkItemRelationships(projectId, workItemId) {
  ensureApi();
  try {
    const activities = await getActivitiesWithCache(projectId, workItemId);

    // Relationship fields that can be tracked
    const relationshipFields = ['relates_to', 'blocks', 'blocked_by', 'depends_on', 'parent'];
    const currentRelationships = {};

    // Sort activities by creation date (newest first)
    activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    for (const activity of activities) {
      const field = activity.field;
      if (relationshipFields.includes(field) && !currentRelationships[field]) {
        // This is the most recent activity for this relationship field
        currentRelationships[field] = {
          value: activity.new_value,
          updated_at: activity.created_at,
          updated_by: activity.actor
        };
      }
    }

    return currentRelationships;
  } catch (error) {
    logger.warn(
      `Failed to fetch relationships for ${workItemId}: ${error.message}`
    );
    return {};
  }
}

/**
 * Get all team activities for a date range
 * Returns structured data ready for summarization
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} projectFilter - Optional project name or identifier to filter by
 * @param {string} actorFilter - Optional actor name or identifier to filter by
 */
async function getTeamActivities(startDate, endDate, projectFilter = null, actorFilter = null) {
  return _getTeamActivitiesInternal(startDate, endDate, projectFilter, actorFilter);
}

/**
 * Process a single project's activities - optimized version
 */
async function processProjectActivities(
  project,
  startDate,
  endDate,
  actorFilter,
  activityLimiter
) {
  const activities = [];
  const projectId = project.id;
  const projectIdentifier = project.identifier || project.name;

  // Start a new caching session for this project
  startProjectSession(projectId);

  // OPTIMIZATION: Fetch project members first
  let projectMembers;
  try {
    projectMembers = await getProjectMembers(projectId);
    logger.info(`Project ${projectIdentifier}: ${projectMembers.length} members`);
  } catch (error) {
    if (error.response?.status === 403) {
      logger.warn(`Skipping project ${projectIdentifier}: no access (403)`);
      return [];
    }
    throw error;
  }

  // If no members, skip this project
  if (projectMembers.length === 0) {
    logger.info(`Skipping ${projectIdentifier} - no project members`);
    return [];
  }

  // Extract member IDs for filtering
  const { memberIds, memberNames } = extractMemberIds(projectMembers);
  logger.debug(`Project ${projectIdentifier} member IDs: ${[...memberIds].join(", ")}`);

  // Fetch work items for this project
  let workItems;
  try {
    workItems = await getWorkItemsWithCache(projectId);
  } catch (error) {
    if (error.response?.status === 403) {
      logger.warn(`Skipping project ${projectIdentifier}: no access (403)`);
      return [];
    }
    throw error;
  }

  logger.info(`Project ${projectIdentifier}: ${workItems.length} work items`);

  // Skip if no work items found
  if (workItems.length === 0) {
    logger.info(`Skipping ${projectIdentifier} - no work items`);
    return [];
  }

  // OPTIMIZATION: Pre-filter work items to only those:
  // 1. Updated/created in date range
  // 2. Assigned to project members
  const relevantWorkItems = [];

  for (const workItem of workItems) {
    const createdAt = new Date(workItem.created_at);
    const updatedAt = new Date(workItem.updated_at);
    const itemInDateRange =
      (createdAt >= startDate && createdAt <= endDate) ||
      (updatedAt >= startDate && updatedAt <= endDate);

    if (!itemInDateRange) continue;

    // OPTIMIZATION: Only include work items relevant to project members
    // (assigned to, created by, or updated by project members)
    if (!isRelevantToMembers(workItem, memberIds)) {
      continue;
    }

    // Extract assignee names from the work item
    const assigneeNames = workItem.assignee_details?.map(
      (a) => a.display_name || a.email || "Unassigned"
    ) || [];

    relevantWorkItems.push({
      projectId,
      workItemId: workItem.id,
      workItemIdentifier: `${projectIdentifier}-${workItem.sequence_id}`,
      workItemName: workItem.name,
      projectIdentifier,
      createdAt,
      updatedAt,
      assignees: assigneeNames,
      state: workItem.state?.name || workItem.state_detail?.name || "Unknown",
      priority: workItem.priority || "none",
      relationships: {},
    });
  }

  logger.info(`Project ${projectIdentifier}: ${relevantWorkItems.length} relevant work items (filtered from ${workItems.length})`);

  // Process relevant work items in parallel with concurrency limit
  await Promise.all(
    relevantWorkItems.map((task) =>
      activityLimiter.run(async () => {
        try {
          // Fetch activities, comments, subitems in parallel for this work item
          const [itemActivities, comments, subitems] = await Promise.all([
            getActivitiesWithCache(task.projectId, task.workItemId),
            getCommentsWithCache(task.projectId, task.workItemId).catch(() => []),
            getSubitemsWithCache(task.projectId, task.workItemId).catch(() => []),
          ]);

          // Extract relationships from activities (no extra API call needed)
          const relationshipFields = ['relates_to', 'blocks', 'blocked_by', 'depends_on', 'parent'];
          const currentRelationships = {};
          const sortedActivities = [...itemActivities].sort((a, b) =>
            new Date(b.created_at) - new Date(a.created_at)
          );
          for (const activity of sortedActivities) {
            const field = activity.field;
            if (relationshipFields.includes(field) && !currentRelationships[field]) {
              currentRelationships[field] = {
                value: activity.new_value,
                updated_at: activity.created_at,
                updated_by: activity.actor
              };
            }
          }
          task.relationships = currentRelationships;

          let foundActivityInRange = false;

          // Filter and transform activities within date range
          for (const activity of itemActivities.slice(0, MAX_ACTIVITIES_PER_ITEM)) {
            const activityDate = new Date(activity.created_at || activity.updated_at);
            if (activityDate >= startDate && activityDate <= endDate) {
              // Get actor name from cache (preloaded)
              const actorName = await fetchUserName(activity.actor);

              // Filter by actor if requested (fuzzy name matching)
              if (actorFilter && !namesMatch(actorName, actorFilter)) {
                continue;
              }

              foundActivityInRange = true;

              logger.debug(`Activity: ${task.workItemIdentifier} by ${actorName}`);

              activities.push({
                type: "activity",
                workItem: task.workItemIdentifier,
                workItemName: task.workItemName,
                project: task.projectIdentifier,
                actor: actorName,
                field: activity.field || "status",
                oldValue: activity.old_value,
                newValue: activity.new_value,
                verb: activity.verb || "updated",
                time: activityDate.toISOString(),
                state: task.state || "Unknown",
                relationships: task.relationships,
              });
            }
          }

          // Process comments
          for (const comment of comments.slice(0, MAX_ACTIVITIES_PER_ITEM)) {
            const commentDate = new Date(comment.created_at);
            if (commentDate >= startDate && commentDate <= endDate) {
              foundActivityInRange = true;

              const commentActor = await fetchUserName(comment.actor || comment.created_by);

              // For comments: only include if the person being processed wrote the comment
              if (actorFilter && !namesMatch(commentActor, actorFilter)) {
                logger.debug(`Comment on ${task.workItemIdentifier}: written by ${commentActor}, but filtering for ${actorFilter}, skipping`);
                continue;
              }

              logger.debug(`  ✓ Including comment on ${task.workItemIdentifier} by ${commentActor}`);

              activities.push({
                type: "comment",
                workItem: task.workItemIdentifier,
                workItemName: task.workItemName,
                project: task.projectIdentifier,
                actor: commentActor,
                comment:
                  comment.comment_stripped ||
                  comment.comment_html?.replace(/<[^>]*>/g, "") ||
                  "",
                time: commentDate.toISOString(),
                state: task.state || "Unknown",
                relationships: task.relationships,
              });
            }
          }

          // Process subitems
          if (subitems && subitems.length > 0) {
            for (const subitem of subitems) {
              // Filter by actor (assignee) if requested (fuzzy name matching)
              if (actorFilter) {
                const isAssignee = subitem.assignee_details?.some(
                  (a) =>
                    namesMatch(a.display_name, actorFilter) || namesMatch(a.email, actorFilter)
                );
                if (!isAssignee) continue;
              }

              const subitemIdentifier = `${task.projectIdentifier}-${subitem.sequence_id}`;
              const subitemState =
                subitem.state?.name || subitem.state_detail?.name || "Unknown";
              const subitemPriority = subitem.priority || "none";
              const subitemProgress = subitem.progress || {};
              const completionPercentage = subitemProgress.total_issues
                ? Math.round(
                  ((subitemProgress.completed_issues || 0) /
                    (subitemProgress.total_issues || 1)) *
                  100
                )
                : 0;

              activities.push({
                type: "subitem",
                parentWorkItem: task.workItemIdentifier,
                parentWorkItemName: task.workItemName,
                project: task.projectIdentifier,
                workItem: subitemIdentifier,
                workItemName: subitem.name,
                state: subitemState,
                priority: subitemPriority,
                assignees: subitem.assignee_details?.map(
                  (a) => a.display_name || a.email || "Unassigned"
                ) || ["Unassigned"],
                progress: {
                  completedIssues: subitemProgress.completed_issues || 0,
                  totalIssues: subitemProgress.total_issues || 0,
                  percentageComplete: completionPercentage,
                },
                createdAt: subitem.created_at,
                updatedAt: subitem.updated_at,
              });
            }
          }

          // If no activities found, add snapshot ONLY if the actor is assigned to this work item
          if (!foundActivityInRange) {
            const isAssigned = !actorFilter || (task.assignees && task.assignees.some(a => namesMatch(a, actorFilter)));

            if (isAssigned) {
              activities.push({
                type: "work_item_snapshot",
                workItem: task.workItemIdentifier,
                workItemName: task.workItemName,
                project: task.projectIdentifier,
                state: task.state || "Unknown",
                priority: task.priority || "None",
                assignees: task.assignees || [],
                createdAt: task.createdAt.toISOString(),
                updatedAt: task.updatedAt.toISOString(),
                relationships: task.relationships,
              });
            }
          }
        } catch (error) {
          logger.warn(
            `Error fetching activities for ${task.workItemIdentifier}: ${error.message}`
          );
          // Add snapshot on error ONLY if the actor is assigned to this work item (fuzzy name matching)
          const isAssigned = !actorFilter || (task.assignees && task.assignees.some(a => namesMatch(a, actorFilter)));
          if (isAssigned) {
            activities.push({
              type: "work_item_snapshot",
              workItem: task.workItemIdentifier,
              workItemName: task.workItemName,
              project: task.projectIdentifier,
              state: task.state || "Unknown",
              priority: task.priority || "None",
              assignees: task.assignees || [],
              createdAt: task.createdAt.toISOString(),
              updatedAt: task.updatedAt.toISOString(),
              relationships: task.relationships,
            });
          }
        }
      })
    )
  );

  return activities;
}

/**
 * Internal implementation of getTeamActivities - OPTIMIZED VERSION
 */
async function _getTeamActivitiesInternal(
  startDate,
  endDate,
  projectFilter = null,
  actorFilter = null
) {
  const startTime = Date.now();
  logger.info(
    `🚀 Fetching team activities from ${startDate.toISOString()} to ${endDate.toISOString()}${projectFilter ? ` for project: ${projectFilter}` : ""
    }${actorFilter ? ` for actor: ${actorFilter}` : ""}`
  );

  // OPTIMIZATION: Preload all users at the start for fast lookup
  await preloadAllUsers();

  const activityLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_ACTIVITY_FETCHES);
  const projectLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_PROJECT_FETCHES);

  // Fetch projects from cache (or fetch if expired)
  let projects = await getProjectsWithCache();

  // Filter projects if projectFilter is provided
  if (projectFilter) {
    const filterLower = projectFilter.toLowerCase();
    projects = projects.filter(
      (p) =>
        p.name.toLowerCase() === filterLower ||
        p.identifier.toLowerCase() === filterLower
    );

    if (projects.length === 0) {
      logger.warn(`No projects found matching filter: ${projectFilter}`);
      return [];
    }

    logger.info(
      `Filtered to project: ${projects.map((p) => p.name).join(", ")}`
    );
  }

  logger.info(
    `Found ${projects.length} projects${projectFilter ? ` matching "${projectFilter}"` : ""
    }`
  );

  // OPTIMIZATION: Process projects in parallel with concurrency limit
  const allActivities = await Promise.all(
    projects.map((project) =>
      projectLimiter.run(() =>
        processProjectActivities(
          project,
          startDate,
          endDate,
          actorFilter,
          activityLimiter
        )
      )
    )
  );

  // Flatten the activities array
  const activities = allActivities.flat();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info(`✅ Total activities found: ${activities.length} (completed in ${duration}s)`);
  return activities;
}

/**
 * Get work items summary (current state snapshot)
 * Useful for showing current status without historical activities
 */
async function getWorkItemsSnapshot() {
  const snapshot = {
    completed: [],
    inProgress: [],
    blocked: [],
    backlog: [],
    total: 0,
  };

  const projects = await fetchProjects();

  for (const project of projects) {
    const projectId = project.id;
    const projectIdentifier = project.identifier || project.name;

    const workItems = await getWorkItemsWithCache(projectId);

    for (const workItem of workItems) {
      const item = {
        id: `${projectIdentifier}-${workItem.sequence_id}`,
        name: workItem.name,
        project: projectIdentifier,
        state: workItem.state?.name || workItem.state_detail?.name || "Unknown",
        priority: workItem.priority || "none",
        assignees:
          workItem.assignee_details?.map((a) => a.display_name || a.email) ||
          [],
        createdAt: workItem.created_at,
        updatedAt: workItem.updated_at,
      };

      snapshot.total++;

      const stateLower = item.state.toLowerCase();
      if (
        stateLower.includes("done") ||
        stateLower.includes("complete") ||
        stateLower.includes("closed")
      ) {
        snapshot.completed.push(item);
      } else if (stateLower.includes("block")) {
        snapshot.blocked.push(item);
      } else if (
        stateLower.includes("progress") ||
        stateLower.includes("review") ||
        stateLower.includes("active")
      ) {
        snapshot.inProgress.push(item);
      } else {
        snapshot.backlog.push(item);
      }
    }
  }

  return snapshot;
}

/**
 * Fetch cycles for a project
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of cycles with completion info
 */
async function fetchCycles(projectId) {
  ensureApi();
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${serviceConfig.WORKSPACE_SLUG}/projects/${projectId}/cycles/`
        ),
      `fetchCycles(${projectId})`
    );

    const cycles = response.data.results || response.data || [];

    return cycles.map((cycle) => ({
      id: cycle.id,
      name: cycle.name,
      startDate: cycle.start_date,
      endDate: cycle.end_date,
      totalIssues: cycle.total_issues || 0,
      completedIssues: cycle.completed_issues || 0,
      cancelledIssues: cycle.cancelled_issues || 0,
      pendingIssues: cycle.pending_issues || 0,
      progress: cycle.progress || 0,
      isActive: cycle.is_active || false,
      isCurrent: (() => {
        if (!cycle.start_date || !cycle.end_date) return false;
        const now = new Date();
        return new Date(cycle.start_date) <= now && now <= new Date(cycle.end_date);
      })(),
    }));
  } catch (error) {
    if (error.response?.status === 403) {
      logger.warn(`No access to cycles for project ${projectId}`);
      return [];
    }
    logger.error(`Failed to fetch cycles for ${projectId}: ${error.message}`);
    return [];
  }
}

/**
 * Cached wrapper for fetchWorkItems with request deduplication
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} Work items for the project
 */
async function getWorkItemsWithCache(projectId, forceRefresh = false) {
  const cacheKey = `workItems:${projectId}`;
  const cacheEntry = workItemsCache.get(projectId);

  // Return from cache if valid AND in current session
  if (!forceRefresh && cacheEntry && isInCurrentSession(cacheEntry) && isCacheValid(cacheEntry.timestamp, WORK_ITEMS_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached work items for project ${projectId} (session: ${cacheEntry.sessionId})`);
    return cacheEntry.data;
  }

  // Deduplicate: if a request is already in progress, wait for it
  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight work items request for ${projectId}`);
    return pendingRequests.get(cacheKey);
  }

  // Create a new request and store the promise
  const requestPromise = (async () => {
    try {
      logger.debug(`📡 Fetching fresh work items for project ${projectId}`);
      const workItems = await fetchWorkItems(projectId);

      // Store with current session ID
      workItemsCache.set(projectId, {
        data: workItems,
        timestamp: Date.now(),
        sessionId: currentSessionId,
      });

      return workItems;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Cached wrapper for fetchWorkItemActivities with request deduplication
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} Activities for the work item
 */
async function getActivitiesWithCache(projectId, workItemId) {
  const cacheKey = `activities:${workItemId}`;
  const cacheEntry = activitiesCache.get(workItemId);

  // Return from cache if valid AND in current session
  if (cacheEntry && isInCurrentSession(cacheEntry) && isCacheValid(cacheEntry.timestamp, ACTIVITIES_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached activities for work item ${workItemId}`);
    return cacheEntry.data;
  }

  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight activities request for ${workItemId}`);
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      logger.debug(`📡 Fetching fresh activities for work item ${workItemId}`);
      const activities = await fetchWorkItemActivities(projectId, workItemId);

      // Store with current session ID
      activitiesCache.set(workItemId, {
        data: activities,
        timestamp: Date.now(),
        sessionId: currentSessionId,
      });

      return activities;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Cached wrapper for fetchWorkItemComments with request deduplication
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} Comments for the work item
 */
async function getCommentsWithCache(projectId, workItemId) {
  const cacheKey = `comments:${workItemId}`;
  const cacheEntry = commentsCache.get(workItemId);

  // Return from cache if valid AND in current session
  if (cacheEntry && isInCurrentSession(cacheEntry) && isCacheValid(cacheEntry.timestamp, COMMENTS_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached comments for work item ${workItemId}`);
    return cacheEntry.data;
  }

  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight comments request for ${workItemId}`);
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      logger.debug(`📡 Fetching fresh comments for work item ${workItemId}`);
      const comments = await fetchWorkItemComments(projectId, workItemId);

      // Store with current session ID
      commentsCache.set(workItemId, {
        data: comments,
        timestamp: Date.now(),
        sessionId: currentSessionId,
      });

      return comments;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Cached wrapper for fetchWorkItemSubitems with request deduplication
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} Subitems for the work item
 */
async function getSubitemsWithCache(projectId, workItemId) {
  const cacheKey = `subitems:${workItemId}`;
  const cacheEntry = subitemsCache.get(workItemId);

  // Return from cache if valid AND in current session
  if (cacheEntry && isInCurrentSession(cacheEntry) && isCacheValid(cacheEntry.timestamp, SUBITEMS_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached subitems for work item ${workItemId}`);
    return cacheEntry.data;
  }

  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight subitems request for ${workItemId}`);
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      logger.debug(`📡 Fetching fresh subitems for work item ${workItemId}`);
      const subitems = await fetchWorkItemSubitems(projectId, workItemId);

      // Store with current session ID
      subitemsCache.set(workItemId, {
        data: subitems,
        timestamp: Date.now(),
        sessionId: currentSessionId,
      });

      return subitems;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Cached wrapper for fetchCycles with request deduplication
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} Cycles for the project
 */
async function getCyclesWithCache(projectId) {
  const cacheKey = `cycles:${projectId}`;
  const cacheEntry = cyclesCache.get(projectId);

  // Return from cache if valid AND in current session
  if (cacheEntry && isInCurrentSession(cacheEntry) && isCacheValid(cacheEntry.timestamp, CYCLES_CACHE_TTL_MS)) {
    logger.debug(`✓ Using cached cycles for project ${projectId}`);
    return cacheEntry.data;
  }

  if (pendingRequests.has(cacheKey)) {
    logger.debug(`⏳ Waiting for in-flight cycles request for ${projectId}`);
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      logger.debug(`📡 Fetching fresh cycles for project ${projectId}`);
      const cycles = await fetchCycles(projectId);

      // Store with current session ID
      cyclesCache.set(projectId, {
        data: cycles,
        timestamp: Date.now(),
        sessionId: currentSessionId,
      });

      return cycles;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Clear activity-related caches to ensure fresh data for each person
 * This prevents data mixing between different users' summaries
 */
function clearActivityCaches() {
  activitiesCache.clear();
  commentsCache.clear();
  subitemsCache.clear();
  // Clear pending requests to avoid stale promises
  pendingRequests.clear();
  logger.debug('Cleared activity caches for fresh data fetch');
}

export {
  initPlaneService,
  fetchProjects,
  fetchWorkItems,
  getWorkItemsWithCache,
  fetchWorkItemActivities,
  getActivitiesWithCache,
  fetchWorkItemComments,
  getCommentsWithCache,
  fetchWorkItemSubitems,
  getSubitemsWithCache,
  fetchWorkItemRelationships,
  getTeamActivities,
  getWorkItemsSnapshot,
  getWorkspaceMembers,
  getProjectMembers,
  getWorkspaceDetails,
  getWorkspaceActivities,
  fetchCycles,
  getCyclesWithCache,
  clearActivityCaches,
  startProjectSession,
  clearProjectCache,
  preloadAllUsers,
};
