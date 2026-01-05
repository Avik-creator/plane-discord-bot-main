/**
 * Utility helper functions
 */

import logger from "../../utils/logger.js";

/**
 * Sleep for a specified number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a name for comparison by removing special characters
 * Handles variations like "shruti.dhasmana" vs "Shruti Dhasmana"
 * @param {string} name - Name to normalize
 * @returns {string} Normalized name
 */
export function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name.toLowerCase().replace(/[.\-_\s]+/g, "");
}

/**
 * Check if two names match (handles different formats)
 * e.g., "shruti.dhasmana" matches "Shruti Dhasmana"
 * @param {string} name1 - First name to compare
 * @param {string} name2 - Second name to compare
 * @returns {boolean} True if names match
 */
export function namesMatch(name1, name2) {
  if (!name1 || !name2) return false;
  return normalizeName(name1) === normalizeName(name2);
}

/**
 * Extract pagination cursor from API response
 * @param {Object} data - Response data
 * @returns {string|null} Next cursor or null if no more pages
 */
export function getNextCursor(data) {
  return data?.next_cursor || null;
}

/**
 * Check if response contains results
 * @param {*} data - Response data
 * @returns {Array} Array of results or empty array
 */
export function getResults(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.results)) {
    return data.results;
  }
  if (data?.grouped_by && Object.keys(data.grouped_by).length > 0) {
    const results = [];
    for (const group of Object.values(data.grouped_by)) {
      if (Array.isArray(group)) {
        results.push(...group);
      }
    }
    return results;
  }
  return [];
}

/**
 * Extract state name from work item
 * @param {Object} workItem - Work item object
 * @returns {string} State name or "Unknown"
 */
export function getWorkItemState(workItem) {
  return workItem.state_detail?.name || workItem.state || "Unknown";
}

/**
 * Extract priority from work item
 * @param {Object} workItem - Work item object
 * @returns {string} Priority or "none"
 */
export function getWorkItemPriority(workItem) {
  return workItem.priority || "none";
}

/**
 * Extract assignee names from work item
 * @param {Object} workItem - Work item object
 * @returns {Array<string>} Array of assignee names
 */
export function getAssigneeNames(workItem) {
  return (
    workItem.assignee_details?.map(
      (a) => a.display_name || a.email || "Unassigned"
    ) || []
  );
}

/**
 * Classify work item by state
 * @param {string} state - State name
 * @returns {string} Classification: "completed", "blocked", "inProgress", or "backlog"
 */
export function classifyWorkItemState(state) {
  if (!state) return "backlog";

  const stateLower = state.toLowerCase();
  if (
    stateLower.includes("done") ||
    stateLower.includes("complete") ||
    stateLower.includes("closed")
  ) {
    return "completed";
  } else if (stateLower.includes("block")) {
    return "blocked";
  } else if (
    stateLower.includes("progress") ||
    stateLower.includes("review") ||
    stateLower.includes("active")
  ) {
    return "inProgress";
  }
  return "backlog";
}

/**
 * Calculate completion percentage
 * @param {number} completed - Number of completed items
 * @param {number} total - Total number of items
 * @returns {number} Percentage (0-100)
 */
export function calculateCompletionPercentage(completed, total) {
  if (!total) return 0;
  return Math.round((completed / total) * 100);
}

/**
 * Check if date is within range
 * @param {Date} date - Date to check
 * @param {Date} startDate - Range start
 * @param {Date} endDate - Range end
 * @returns {boolean} True if date is within range
 */
export function isDateInRange(date, startDate, endDate) {
  return date >= startDate && date <= endDate;
}

/**
 * Extract comment text from comment object
 * @param {Object} comment - Comment object
 * @returns {string} Comment text or empty string
 */
export function getCommentText(comment) {
  return (
    comment.comment_stripped ||
    comment.comment_html?.replace(/<[^>]*>/g, "") ||
    ""
  );
}

/**
 * Get actor name from comment/activity
 * @param {Object} item - Comment or activity object
 * @returns {string} Actor ID to fetch name for
 */
export function getActorId(item) {
  return item.actor || item.created_by || item.user_id || null;
}
