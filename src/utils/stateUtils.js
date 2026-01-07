/**
 * State detection patterns (case-insensitive)
 */
export const STATE_PATTERNS = {
  completed: ["done", "closed", "complete", "completed", "resolved"],
  blocked: ["block", "blocked", "blocking", "stuck", "on hold"],
  inProgress: ["progress", "in progress", "review", "active", "working", "started", "in review", "in qa"],
  backlog: ["backlog", "todo", "to do", "open", "new", "planned"],
};

/**
 * Check if a state string matches a category
 * @param {string} state - State string to check
 * @param {string} category - Category to match against (completed, blocked, inProgress, backlog)
 * @returns {boolean} Whether the state matches the category
 */
export function matchesStateCategory(state, category) {
  if (!state || typeof state !== "string") return false;
  const stateLower = state.toLowerCase();
  const patterns = STATE_PATTERNS[category] || [];
  return patterns.some((pattern) => stateLower.includes(pattern));
}

/**
 * Categorize work items by state
 * @param {Array} workItems - Array of work items with state property
 * @returns {Object} Categorized work items { completed: [], inProgress: [], blocked: [], backlog: [] }
 */
export function categorizeWorkItems(workItems) {
  const categorized = {
    completed: [],
    inProgress: [],
    blocked: [],
    backlog: []
  };

  for (const item of workItems) {
    const state = item.state || item.state_detail?.name || "Unknown";
    const stateLower = state.toLowerCase();

    if (matchesStateCategory(state, "completed")) {
      categorized.completed.push(item);
    } else if (matchesStateCategory(state, "blocked")) {
      categorized.blocked.push(item);
    } else if (matchesStateCategory(state, "inProgress")) {
      categorized.inProgress.push(item);
    } else {
      categorized.backlog.push(item);
    }
  }

  return categorized;
}
