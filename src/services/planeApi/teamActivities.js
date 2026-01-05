/**
 * Team activities aggregation and processing
 * Handles collecting and filtering activities across multiple projects and work items
 */

import logger from "../../utils/logger.js";
import {
  getProjectsWithCache,
  getWorkItemsWithCache,
  getActivitiesWithCache,
  getCommentsWithCache,
  getSubitemsWithCache,
  fetchUserName,
} from "./dataFetchers.js";
import { ConcurrencyLimiter } from "./apiRequest.js";
import { MAX_CONCURRENT_ACTIVITY_FETCHES } from "./constants.js";
import {
  namesMatch,
  isDateInRange,
  getCommentText,
  getActorId,
  calculateCompletionPercentage,
} from "./helpers.js";

/**
 * Transform activity into standardized format
 * @private
 */
function transformActivity(activity, task, actorName) {
  return {
    type: "activity",
    workItem: task.workItemIdentifier,
    workItemName: task.workItemName,
    project: task.projectIdentifier,
    actor: actorName,
    field: activity.field || "status",
    oldValue: activity.old_value,
    newValue: activity.new_value,
    verb: activity.verb || "updated",
    time: new Date(activity.created_at || activity.updated_at).toISOString(),
  };
}

/**
 * Transform comment into standardized format
 * @private
 */
function transformComment(comment, task, commentActor) {
  return {
    type: "comment",
    workItem: task.workItemIdentifier,
    workItemName: task.workItemName,
    project: task.projectIdentifier,
    actor: commentActor,
    comment: getCommentText(comment),
    time: new Date(comment.created_at).toISOString(),
  };
}

/**
 * Transform subitem into standardized format
 * @private
 */
function transformSubitem(subitem, task, projectIdentifier) {
  const subitemProgress = subitem.progress || {};
  const completionPercentage = calculateCompletionPercentage(
    subitemProgress.completed_issues || 0,
    subitemProgress.total_issues || 0
  );

  return {
    type: "subitem",
    parentWorkItem: task.workItemIdentifier,
    parentWorkItemName: task.workItemName,
    project: projectIdentifier,
    workItem: `${projectIdentifier}-${subitem.sequence_id}`,
    workItemName: subitem.name,
    state: subitem.state_detail?.name || subitem.state || "Unknown",
    priority: subitem.priority || "none",
    assignees:
      subitem.assignee_details?.map((a) => a.display_name || a.email || "Unassigned") ||
      ["Unassigned"],
    progress: {
      completedIssues: subitemProgress.completed_issues || 0,
      totalIssues: subitemProgress.total_issues || 0,
      percentageComplete: completionPercentage,
    },
    createdAt: subitem.created_at,
    updatedAt: subitem.updated_at,
  };
}

/**
 * Create work item snapshot
 * @private
 */
function createWorkItemSnapshot(task) {
  return {
    type: "work_item_snapshot",
    workItem: task.workItemIdentifier,
    workItemName: task.workItemName,
    project: task.projectIdentifier,
    state: task.state || "Unknown",
    priority: task.priority || "None",
    assignees: task.assignees || [],
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/**
 * Check if actor should be included in results
 * @private
 */
function shouldIncludeActor(actorFilter, actorName) {
  if (!actorFilter) return true;
  return namesMatch(actorName, actorFilter);
}

/**
 * Check if assignee matches actor filter
 * @private
 */
function isAssignedToActor(assignees, actorFilter) {
  if (!actorFilter || !assignees) return true;
  return assignees.some((a) => namesMatch(a, actorFilter));
}

/**
 * Prepare work items for activity collection
 * @private
 */
function prepareWorkItemTasks(workItems, projectIdentifier, startDate, endDate) {
  return workItems
    .map((workItem) => {
      const createdAt = new Date(workItem.created_at);
      const updatedAt = new Date(workItem.updated_at);
      const itemInDateRange =
        isDateInRange(createdAt, startDate, endDate) ||
        isDateInRange(updatedAt, startDate, endDate);

      if (!itemInDateRange) {
        return null;
      }

      return {
        projectId: workItem.project_id || workItem.id,
        workItemId: workItem.id,
        workItemIdentifier: `${projectIdentifier}-${workItem.sequence_id}`,
        workItemName: workItem.name,
        projectIdentifier,
        createdAt,
        updatedAt,
        assignees: workItem.assignee_details?.map(
          (a) => a.display_name || a.email || "Unassigned"
        ) || [],
        state: workItem.state_detail?.name || workItem.state || "Unknown",
        priority: workItem.priority || "none",
      };
    })
    .filter((task) => task !== null);
}

/**
 * Collect activities for a single work item
 * @private
 */
async function collectWorkItemActivities(
  task,
  activities,
  startDate,
  endDate,
  actorFilter,
  fetchUserName
) {
  let foundActivityInRange = false;

  // Process activities
  const itemActivities = await getActivitiesWithCache(task.projectId, task.workItemId);
  for (const activity of itemActivities) {
    const activityDate = new Date(activity.created_at || activity.updated_at);
    if (!isDateInRange(activityDate, startDate, endDate)) continue;

    const actorName = await fetchUserName(activity.actor);
    if (!shouldIncludeActor(actorFilter, actorName)) continue;

    foundActivityInRange = true;
    logger.debug(`Activity: ${task.workItemIdentifier} by ${actorName}`);
    activities.push(transformActivity(activity, task, actorName));
  }

  return foundActivityInRange;
}

/**
 * Collect comments for a single work item
 * @private
 */
async function collectWorkItemComments(
  task,
  activities,
  startDate,
  endDate,
  actorFilter,
  fetchUserName
) {
  let foundActivityInRange = false;

  try {
    const comments = await getCommentsWithCache(task.projectId, task.workItemId);

    for (const comment of comments) {
      const commentDate = new Date(comment.created_at);
      if (!isDateInRange(commentDate, startDate, endDate)) continue;

      const commentActor = await fetchUserName(getActorId(comment));
      if (!shouldIncludeActor(actorFilter, commentActor)) continue;

      foundActivityInRange = true;
      activities.push(transformComment(comment, task, commentActor));
    }
  } catch (error) {
    logger.debug(
      `Could not fetch comments for ${task.workItemIdentifier}: ${error.message}`
    );
  }

  return foundActivityInRange;
}

/**
 * Collect subitems for a single work item
 * @private
 */
async function collectWorkItemSubitems(task, activities, actorFilter) {
  try {
    const subitems = await getSubitemsWithCache(task.projectId, task.workItemId);

    if (subitems && subitems.length > 0) {
      for (const subitem of subitems) {
        const subitemAssignees = subitem.assignee_details?.map(
          (a) => a.display_name || a.email
        ) || [];
        
        if (!isAssignedToActor(subitemAssignees, actorFilter)) continue;

        activities.push(transformSubitem(subitem, task, task.projectIdentifier));
      }
    }
  } catch (error) {
    logger.debug(
      `Could not fetch subitems for ${task.workItemIdentifier}: ${error.message}`
    );
  }
}

/**
 * Get all team activities for a date range
 * Returns structured data ready for summarization
 * @param {Date} startDate - Start of date range
 * @param {Date} endDate - End of date range
 * @param {string} projectFilter - Optional project name or identifier to filter by
 * @param {string} actorFilter - Optional actor name or identifier to filter by
 * @returns {Promise<Array>} List of activities and snapshots
 */
export async function getTeamActivities(
  startDate,
  endDate,
  projectFilter = null,
  actorFilter = null
) {
  logger.info(
    `Fetching team activities from ${startDate.toISOString()} to ${endDate.toISOString()}${
      projectFilter ? ` for project: ${projectFilter}` : ""
    }`
  );

  const activities = [];
  const limiter = new ConcurrencyLimiter(MAX_CONCURRENT_ACTIVITY_FETCHES);

  // Fetch and filter projects
  let projects = await getProjectsWithCache();

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
    `Found ${projects.length} projects${
      projectFilter ? ` matching "${projectFilter}"` : ""
    }`
  );

  // Collect all work item tasks
  const activityFetchTasks = [];

  for (const project of projects) {
    const projectId = project.id;
    const projectIdentifier = project.identifier || project.name;

    let workItems;
    try {
      workItems = await getWorkItemsWithCache(projectId);
    } catch (error) {
      if (error.response?.status === 403) {
        logger.warn(`Skipping project ${projectIdentifier}: no access (403)`);
        continue;
      }
      throw error;
    }

    logger.info(`Project ${projectIdentifier}: ${workItems.length} work items`);

    if (workItems.length === 0) {
      logger.info(`Skipping ${projectIdentifier} - no work items`);
      continue;
    }

    const tasks = prepareWorkItemTasks(workItems, projectIdentifier, startDate, endDate);
    activityFetchTasks.push(...tasks);
  }

  // Fetch activities in parallel with concurrency limit
  await Promise.all(
    activityFetchTasks.map((task) =>
      limiter.run(async () => {
        try {
          let foundActivityInRange = false;

          // Collect activities
          foundActivityInRange =
            (await collectWorkItemActivities(
              task,
              activities,
              startDate,
              endDate,
              actorFilter,
              fetchUserName
            )) || foundActivityInRange;

          // Collect comments
          foundActivityInRange =
            (await collectWorkItemComments(
              task,
              activities,
              startDate,
              endDate,
              actorFilter,
              fetchUserName
            )) || foundActivityInRange;

          // Collect subitems
          await collectWorkItemSubitems(task, activities, actorFilter);

          // Add snapshot if no activities found but actor is assigned
          if (!foundActivityInRange) {
            const isAssigned = isAssignedToActor(task.assignees, actorFilter);
            if (isAssigned) {
              activities.push(createWorkItemSnapshot(task));
            }
          }
        } catch (error) {
          logger.warn(
            `Error fetching activities for ${task.workItemIdentifier}: ${error.message}`
          );

          // Add snapshot on error if actor is assigned
          const isAssigned = isAssignedToActor(task.assignees, actorFilter);
          if (isAssigned) {
            activities.push(createWorkItemSnapshot(task));
          }
        }
      })
    )
  );

  logger.info(`Total activities found: ${activities.length}`);
  return activities;
}

/**
 * Get work items snapshot (current state)
 * Useful for showing current status without historical activities
 * @returns {Promise<Object>} Snapshot with work items grouped by state
 */
export async function getWorkItemsSnapshot() {
  const snapshot = {
    completed: [],
    inProgress: [],
    blocked: [],
    backlog: [],
    total: 0,
  };

  const projects = await getProjectsWithCache();

  for (const project of projects) {
    const projectId = project.id;
    const projectIdentifier = project.identifier || project.name;

    const workItems = await getWorkItemsWithCache(projectId);

    for (const workItem of workItems) {
      const item = {
        id: `${projectIdentifier}-${workItem.sequence_id}`,
        name: workItem.name,
        project: projectIdentifier,
        state: workItem.state_detail?.name || workItem.state || "Unknown",
        priority: workItem.priority || "none",
        assignees:
          workItem.assignee_details?.map((a) => a.display_name || a.email) || [],
        createdAt: workItem.created_at,
        updatedAt: workItem.updated_at,
      };

      snapshot.total++;

      const stateClassification = item.state.toLowerCase();
      if (
        stateClassification.includes("done") ||
        stateClassification.includes("complete") ||
        stateClassification.includes("closed")
      ) {
        snapshot.completed.push(item);
      } else if (stateClassification.includes("block")) {
        snapshot.blocked.push(item);
      } else if (
        stateClassification.includes("progress") ||
        stateClassification.includes("review") ||
        stateClassification.includes("active")
      ) {
        snapshot.inProgress.push(item);
      } else {
        snapshot.backlog.push(item);
      }
    }
  }

  return snapshot;
}
