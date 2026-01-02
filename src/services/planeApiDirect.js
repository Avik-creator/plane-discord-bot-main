/**
 * Plane API Service (Direct)
 *
 * Fetches data directly from Plane API without database storage.
 * All data is fetched on-demand and processed in memory.
 */
const axios = require("axios");
const config = require("../config/config.enhanced");
const logger = require("../utils/logger");

const PLANE_API = axios.create({
  baseURL: config.PLANE_BASE_URL,
  headers: {
    "X-API-Key": config.PLANE_API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 60000,
});

// Rate limiting - only backoff on 429
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_WORK_ITEMS_PER_PROJECT = 200;
const MAX_ACTIVITIES_PER_ITEM = 20;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_CONCURRENT_ACTIVITY_FETCHES = 3; // Lowered to avoid 429s
const BATCH_DELAY_MS = 1000; // Delay between batches
const PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000; // Cache projects for 5 minutes
const USERS_CACHE_TTL_MS = 30 * 60 * 1000; // Cache users for 30 minutes

// Cache
let projectsCache = null;
let projectsCacheTime = null;
let workspaceDetailsCache = null;
let usersCache = new Map(); // Map of userId -> user details

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          `/workspaces/${config.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/comments/`
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
          `/workspaces/${config.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/sub-issues/`
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
 * Fetch user details by ID from workspace members
 */
async function fetchUserName(userId) {
  if (!userId) return "Unknown";

  // Check cache first
  const cached = usersCache.get(userId);
  if (cached) {
    return cached;
  }

  try {
    // Fetch workspace members list
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${config.WORKSPACE_SLUG}/members/`, {
          params: { page: 1, per_page: 100 },
        }),
      `fetchMembers`
    );

    const members = response.data.results || response.data || [];

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
 * Fetch all workspace members
 */
async function getWorkspaceMembers() {
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${config.WORKSPACE_SLUG}/members/`, {
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
 * Fetch workspace details
 */
async function getWorkspaceDetails() {
  if (workspaceDetailsCache) return workspaceDetailsCache;

  try {
    const response = await apiRequestWithRetry(
      () => PLANE_API.get(`/workspaces/${config.WORKSPACE_SLUG}`),
      `getWorkspaceDetails`
    );

    workspaceDetailsCache = response.data;
    return workspaceDetailsCache;
  } catch (error) {
    logger.error(`Failed to fetch workspace details: ${error.message}`);
    return { name: config.WORKSPACE_SLUG, slug: config.WORKSPACE_SLUG };
  }
}

/**
 * Fetch workspace-wide activities with filtering
 * @param {Object} params - Query parameters (actor, created_at__gte, etc.)
 */
async function getWorkspaceActivities(params) {
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${config.WORKSPACE_SLUG}/activities/`, {
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
  const projects = [];
  let cursor = null;
  let hasMore = true;
  let fetchCount = 0;

  while (hasMore) {
    fetchCount++;
    if (fetchCount > 10) {
      logger.warn("Too many fetchProjects iterations, breaking");
      break;
    }

    const params = cursor ? { cursor } : {};
    logger.debug(
      `Fetching projects ${cursor ? `(cursor: ${cursor})` : "(page 1)"}`
    );
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(`/workspaces/${config.WORKSPACE_SLUG}/projects/`, {
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
    `Fetched ${projects.length} projects total after ${fetchCount} iterations`
  );
  return projects;
}

/**
 * Fetch all work items from a project
 */
async function fetchWorkItems(projectId) {
  const workItems = [];
  let cursor = null;
  let hasMore = true;

  while (hasMore && workItems.length < MAX_WORK_ITEMS_PER_PROJECT) {
    const params = {
      order_by: "-updated_at", // Fetch most recently updated first
      ...(cursor ? { cursor } : {}),
    };
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${config.WORKSPACE_SLUG}/projects/${projectId}/work-items/`,
          { params }
        ),
      `fetchWorkItems(${projectId})`
    );

    const data = response.data;
    logger.info(
      `Work items API response: ${JSON.stringify({
        isArray: Array.isArray(data),
        hasResults: !!data.results,
        count: Array.isArray(data) ? data.length : data.results?.length || 0,
      })}`
    );

    if (Array.isArray(data)) {
      workItems.push(
        ...data.slice(0, MAX_WORK_ITEMS_PER_PROJECT - workItems.length)
      );
      hasMore = false;
    } else if (data.results) {
      workItems.push(
        ...data.results.slice(0, MAX_WORK_ITEMS_PER_PROJECT - workItems.length)
      );
      cursor =
        data.next_cursor && workItems.length < MAX_WORK_ITEMS_PER_PROJECT
          ? data.next_cursor
          : null;
      hasMore = !!cursor;
    } else {
      hasMore = false;
    }
  }

  return workItems;
}

/**
 * Fetch activities for a work item
 */
async function fetchWorkItemActivities(projectId, workItemId) {
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${config.WORKSPACE_SLUG}/projects/${projectId}/work-items/${workItemId}/activities/`
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
 * Get all team activities for a date range
 * Returns structured data ready for summarization
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} projectFilter - Optional project name or identifier to filter by
 */
async function getTeamActivities(startDate, endDate, projectFilter = null) {
  return _getTeamActivitiesInternal(startDate, endDate, projectFilter);
}

/**
 * Internal implementation of getTeamActivities
 */
async function _getTeamActivitiesInternal(
  startDate,
  endDate,
  projectFilter = null
) {
  logger.info(
    `Fetching team activities from ${startDate.toISOString()} to ${endDate.toISOString()}${projectFilter ? ` for project: ${projectFilter}` : ""
    }`
  );

  const activities = [];
  const limiter = new ConcurrencyLimiter(MAX_CONCURRENT_ACTIVITY_FETCHES);

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

  // Collect all activity fetch tasks
  const activityFetchTasks = [];

  for (const project of projects) {
    const projectId = project.id;
    const projectIdentifier = project.identifier || project.name;

    // Fetch work items for this project
    let workItems;
    try {
      workItems = await fetchWorkItems(projectId);
    } catch (error) {
      if (error.response?.status === 403) {
        logger.warn(`Skipping project ${projectIdentifier}: no access (403)`);
        continue;
      }
      throw error;
    }

    logger.info(`Project ${projectIdentifier}: ${workItems.length} work items`);

    for (const workItem of workItems) {
      const workItemId = workItem.id;
      const workItemIdentifier = `${projectIdentifier}-${workItem.sequence_id}`;
      const workItemName = workItem.name;

      // Check if work item was created or updated in the date range
      const createdAt = new Date(workItem.created_at);
      const updatedAt = new Date(workItem.updated_at);
      const itemInDateRange =
        (createdAt >= startDate && createdAt <= endDate) ||
        (updatedAt >= startDate && updatedAt <= endDate);

      if (!itemInDateRange) {
        // Item wasn't created/updated in range, skip
        continue;
      }

      // Queue activity fetch task
      activityFetchTasks.push({
        projectId,
        workItemId,
        workItemIdentifier,
        workItemName,
        projectIdentifier,
        createdAt,
        updatedAt,
      });
    }
  }

  // Fetch all activities in parallel with concurrency limit
  await Promise.all(
    activityFetchTasks.map((task) =>
      limiter.run(async () => {
        try {
          const itemActivities = await fetchWorkItemActivities(
            task.projectId,
            task.workItemId
          );

          let foundActivityInRange = false;

          // Filter and transform activities within date range
          for (const activity of itemActivities.slice(
            0,
            MAX_ACTIVITIES_PER_ITEM
          )) {
            const activityDate = new Date(
              activity.created_at || activity.updated_at
            );
            if (activityDate >= startDate && activityDate <= endDate) {
              foundActivityInRange = true;

              // Fetch actor name from user ID
              const actorName = await fetchUserName(activity.actor);

              logger.debug(
                `Activity: ${task.workItemIdentifier} by ${actorName}`
              );

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
              });
            }
          }

          // Fetch and add comments
          try {
            const comments = await fetchWorkItemComments(
              task.projectId,
              task.workItemId
            );

            for (const comment of comments.slice(0, MAX_ACTIVITIES_PER_ITEM)) {
              const commentDate = new Date(comment.created_at);
              if (commentDate >= startDate && commentDate <= endDate) {
                foundActivityInRange = true;

                const commentActor = await fetchUserName(
                  comment.actor || comment.created_by
                );

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
                });
              }
            }
          } catch (error) {
            logger.debug(
              `Could not fetch comments for ${task.workItemIdentifier}: ${error.message}`
            );
          }

          // Fetch and add subitems with progress info
          try {
            const subitems = await fetchWorkItemSubitems(
              task.projectId,
              task.workItemId
            );

            if (subitems && subitems.length > 0) {
              for (const subitem of subitems) {
                const subitemIdentifier = `${task.projectIdentifier}-${subitem.sequence_id}`;
                const subitemState =
                  subitem.state_detail?.name || subitem.state || "Unknown";
                const subitemPriority = subitem.priority || "none";
                const subitemProgress = subitem.progress || {};
                const completionPercentage = subitemProgress.completed_issues
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
          } catch (error) {
            logger.debug(
              `Could not fetch subitems for ${task.workItemIdentifier}: ${error.message}`
            );
          }

          // If no activities found, add snapshot
          if (!foundActivityInRange) {
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
            });
          }
        } catch (error) {
          logger.warn(
            `Error fetching activities for ${task.workItemIdentifier}: ${error.message}`
          );
          // Add snapshot even on error
          activities.push({
            type: "work_item_snapshot",
            workItem: task.workItemIdentifier,
            workItemName: task.workItemName,
            project: task.projectIdentifier,
            createdAt: task.createdAt.toISOString(),
            updatedAt: task.updatedAt.toISOString(),
          });
        }
      })
    )
  );

  logger.info(`Total activities found: ${activities.length}`);
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

    const workItems = await fetchWorkItems(projectId);

    for (const workItem of workItems) {
      const item = {
        id: `${projectIdentifier}-${workItem.sequence_id}`,
        name: workItem.name,
        project: projectIdentifier,
        state: workItem.state_detail?.name || workItem.state || "Unknown",
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
  try {
    const response = await apiRequestWithRetry(
      () =>
        PLANE_API.get(
          `/workspaces/${config.WORKSPACE_SLUG}/projects/${projectId}/cycles/`
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

module.exports = {
  fetchProjects,
  fetchWorkItems,
  fetchWorkItemActivities,
  fetchWorkItemComments,
  fetchWorkItemSubitems,
  getTeamActivities,
  getWorkItemsSnapshot,
  getWorkspaceMembers,
  getWorkspaceDetails,
  getWorkspaceActivities,
  fetchCycles,
};
