/**
 * Data fetching functions from Plane API
 * Handles fetching of projects, work items, activities, comments, and other data
 */

import logger from "../../utils/logger.js";
import { getServiceConfig } from "./apiClient.js";
import { apiRequestWithRetry, apiGet } from "./apiRequest.js";
import {
  projectsCache,
  usersCache,
  workItemsCache,
  activitiesCache,
  commentsCache,
  subitemsCache,
  cyclesCache,
} from "./cacheManager.js";
import {
  MAX_WORK_ITEMS_PER_PROJECT,
  MAX_ACTIVITIES_PER_ITEM,
  MAX_ITERATIONS,
  MAX_CONCURRENT_ACTIVITY_FETCHES,
} from "./constants.js";
import { getResults, getNextCursor } from "./helpers.js";

/**
 * Fetch all projects in the workspace
 * @returns {Promise<Array>} List of projects
 */
export async function fetchProjects() {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  const projects = [];
  let cursor = null;
  let hasMore = true;
  let iteration = 0;

  while (hasMore) {
    iteration++;
    if (iteration > MAX_ITERATIONS) {
      logger.warn(`Too many fetchProjects iterations, breaking`);
      break;
    }

    const params = cursor ? { cursor } : {};
    logger.debug(
      `Fetching projects ${cursor ? `(cursor: ${cursor})` : `(page ${iteration})`}`
    );

    const response = await apiRequestWithRetry(
      () => apiGet(`/workspaces/${workspace}/projects/`, params, "fetchProjects"),
      "fetchProjects"
    );

    const results = getResults(response.data);
    projects.push(...results);
    cursor = getNextCursor(response.data);
    hasMore = !!cursor;

    logger.info(
      `Projects API response: ${JSON.stringify({
        resultsCount: results.length,
        hasCursor: !!cursor,
      })}`
    );
  }

  logger.info(
    `Fetched ${projects.length} projects total after ${iteration} iterations`
  );
  return projects;
}

/**
 * Fetch projects with caching
 * @returns {Promise<Array>} List of projects
 */
export async function getProjectsWithCache() {
  return projectsCache.getOrFetch("all_projects", () => fetchProjects());
}

/**
 * Fetch all work items from a project
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of work items
 */
export async function fetchWorkItems(projectId) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  const workItems = [];
  let cursor = null;
  let hasMore = true;
  let iteration = 0;

  while (hasMore && workItems.length < MAX_WORK_ITEMS_PER_PROJECT && iteration < MAX_ITERATIONS) {
    iteration++;
    const params = {
      order_by: "-updated_at",
      ...(cursor ? { cursor } : {}),
    };

    const response = await apiRequestWithRetry(
      () =>
        apiGet(
          `/workspaces/${workspace}/projects/${projectId}/work-items/`,
          params,
          `fetchWorkItems(${projectId})`
        ),
      `fetchWorkItems(${projectId})`
    );

    const results = getResults(response.data);
    const remaining = MAX_WORK_ITEMS_PER_PROJECT - workItems.length;
    workItems.push(...results.slice(0, remaining));

    cursor = getNextCursor(response.data);
    hasMore = !!cursor && workItems.length < MAX_WORK_ITEMS_PER_PROJECT;

    logger.info(
      `Work items API response: ${JSON.stringify({
        count: results.length,
        iteration,
      })}`
    );
  }

  if (iteration >= MAX_ITERATIONS) {
    logger.warn(
      `fetchWorkItems hit max iterations (${MAX_ITERATIONS}) for project ${projectId}`
    );
  }

  logger.info(
    `Fetched ${workItems.length} work items for project ${projectId} in ${iteration} iterations`
  );
  return workItems;
}

/**
 * Fetch work items with caching
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of work items
 */
export async function getWorkItemsWithCache(projectId) {
  return workItemsCache.getOrFetch(`project:${projectId}`, () =>
    fetchWorkItems(projectId)
  );
}

/**
 * Fetch activities for a work item
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of activities
 */
export async function fetchWorkItemActivities(projectId, workItemId) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(
          `/workspaces/${workspace}/projects/${projectId}/work-items/${workItemId}/activities/`,
          {},
          `activities(${workItemId})`
        ),
      `activities(${workItemId})`
    );
    return getResults(response.data);
  } catch (error) {
    logger.warn(
      `Failed to fetch activities for ${workItemId}: ${error.message}`
    );
    return [];
  }
}

/**
 * Fetch activities with caching
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of activities
 */
export async function getActivitiesWithCache(projectId, workItemId) {
  return activitiesCache.getOrFetch(`item:${workItemId}`, () =>
    fetchWorkItemActivities(projectId, workItemId)
  );
}

/**
 * Fetch comments for a work item
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of comments
 */
export async function fetchWorkItemComments(projectId, workItemId) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(
          `/workspaces/${workspace}/projects/${projectId}/work-items/${workItemId}/comments/`,
          {},
          `comments(${workItemId})`
        ),
      `comments(${workItemId})`
    );
    return getResults(response.data);
  } catch (error) {
    logger.warn(`Failed to fetch comments for ${workItemId}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch comments with caching
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of comments
 */
export async function getCommentsWithCache(projectId, workItemId) {
  return commentsCache.getOrFetch(`comments:${workItemId}`, () =>
    fetchWorkItemComments(projectId, workItemId)
  );
}

/**
 * Fetch subitems for a work item
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of subitems
 */
export async function fetchWorkItemSubitems(projectId, workItemId) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(
          `/workspaces/${workspace}/projects/${projectId}/work-items/${workItemId}/sub-issues/`,
          {},
          `subitems(${workItemId})`
        ),
      `subitems(${workItemId})`
    );
    return getResults(response.data);
  } catch (error) {
    logger.warn(`Failed to fetch subitems for ${workItemId}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch subitems with caching
 * @param {string} projectId - Project ID
 * @param {string} workItemId - Work item ID
 * @returns {Promise<Array>} List of subitems
 */
export async function getSubitemsWithCache(projectId, workItemId) {
  return subitemsCache.getOrFetch(`subitems:${workItemId}`, () =>
    fetchWorkItemSubitems(projectId, workItemId)
  );
}

/**
 * Fetch cycles for a project
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of cycles with completion info
 */
export async function fetchCycles(projectId) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(
          `/workspaces/${workspace}/projects/${projectId}/cycles/`,
          {},
          `fetchCycles(${projectId})`
        ),
      `fetchCycles(${projectId})`
    );

    const cycles = getResults(response.data);

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
 * Fetch cycles with caching
 * @param {string} projectId - Project ID
 * @returns {Promise<Array>} List of cycles
 */
export async function getCyclesWithCache(projectId) {
  return cyclesCache.getOrFetch(`cycles:${projectId}`, () =>
    fetchCycles(projectId)
  );
}

/**
 * Fetch workspace members
 * @returns {Promise<Array>} List of workspace members
 */
export async function getWorkspaceMembers() {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(`/workspaces/${workspace}/members/`, { page: 1, per_page: 100 }, "getWorkspaceMembers"),
      "getWorkspaceMembers"
    );

    return getResults(response.data);
  } catch (error) {
    logger.error(`Failed to fetch workspace members: ${error.message}`);
    return [];
  }
}

/**
 * Fetch user details by ID
 * @param {string} userId - User ID to fetch
 * @returns {Promise<string>} User display name or ID
 */
export async function fetchUserName(userId) {
  // Check cache first
  const cached = usersCache.get(userId);
  if (cached !== null) {
    return cached;
  }

  try {
    const members = await getWorkspaceMembers();

    // Find user by ID
    const user = members.find((m) =>
      m.id === userId ||
      m.member_id === userId ||
      m.member?.id === userId ||
      m.user?.id === userId
    );

    if (user) {
      const userData = user.member || user.user || user;
      const userName =
        user.display_name ||
        userData.display_name ||
        userData.first_name ||
        userData.email ||
        userId;

      // Cache it
      usersCache.set(userId, userName);
      return userName;
    }

    return userId;
  } catch (error) {
    logger.warn(`Failed to fetch user ${userId}: ${error.message}`);
    return userId;
  }
}

/**
 * Fetch workspace details
 * @returns {Promise<Object>} Workspace details
 */
export async function getWorkspaceDetails() {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () => apiGet(`/workspaces/${workspace}`, {}, "getWorkspaceDetails"),
      "getWorkspaceDetails"
    );

    return response.data;
  } catch (error) {
    logger.error(`Failed to fetch workspace details: ${error.message}`);
    return {
      name: workspace,
      slug: workspace,
    };
  }
}

/**
 * Fetch workspace-wide activities with filtering
 * @param {Object} params - Query parameters (actor, created_at__gte, etc.)
 * @returns {Promise<Array>} List of activities
 */
export async function getWorkspaceActivities(params) {
  const workspace = getServiceConfig().WORKSPACE_SLUG;
  try {
    const response = await apiRequestWithRetry(
      () =>
        apiGet(`/workspaces/${workspace}/activities/`, params, "getWorkspaceActivities"),
      "getWorkspaceActivities"
    );

    return getResults(response.data);
  } catch (error) {
    logger.error(`Failed to fetch workspace activities: ${error.message}`);
    return [];
  }
}
