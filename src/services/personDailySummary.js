/**
 * Person Daily Summary Service
 *
 * Generates person-specific daily activity summaries from Plane API data.
 * Uses the existing getTeamActivities service - no direct Plane API calls.
 */
const {
  getTeamActivities,
  getWorkspaceMembers,
  fetchProjects,
  fetchCycles
} = require("./planeApiDirect");
const { generateText } = require("ai");
const { google } = require("@ai-sdk/google");
const config = require("../config/config.enhanced");
const logger = require("../utils/logger");

/**
 * State detection patterns (case-insensitive)
 */
const STATE_PATTERNS = {
  completed: ["done", "closed", "complete", "completed"],
  blocked: ["block", "blocked", "blocking"],
  inProgress: ["progress", "in progress", "review", "active", "working"],
};

/**
 * Check if a state string matches a category
 * @param {string} state - State value to check
 * @param {string} category - Category to match against (completed, blocked, inProgress)
 * @returns {boolean}
 */
function matchesStateCategory(state, category) {
  if (!state || typeof state !== "string") return false;
  const stateLower = state.toLowerCase();
  const patterns = STATE_PATTERNS[category] || [];
  return patterns.some((pattern) => stateLower.includes(pattern));
}

/**
 * Convert a date string (YYYY-MM-DD) to UTC start/end range
 * @param {string} dateString - Date in YYYY-MM-DD format
 * @returns {{ startDate: Date, endDate: Date }}
 */
function getDateRange(dateString) {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD.`);
  }

  const startDate = new Date(date);
  startDate.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(date);
  endDate.setUTCHours(23, 59, 59, 999);

  return { startDate, endDate };
}

/**
 * Get person-specific daily activity summary
 *
 * @param {Object} params
 * @param {string} params.personName - Name of the person to filter by (exact match on actor)
 * @param {string} params.date - Date in YYYY-MM-DD format
 * @param {string|null} params.projectFilter - Optional project name/identifier to filter by
 * @returns {Promise<Object>} Structured summary object
 */
async function getPersonDailySummary({
  personName,
  date,
  projectFilter = null,
}) {
  logger.info(
    `Generating person daily summary for ${personName} on ${date}${projectFilter ? ` (project: ${projectFilter})` : ""
    }`
  );

  // Validate inputs
  if (!personName || typeof personName !== "string") {
    throw new Error("personName is required and must be a string");
  }
  if (!date || typeof date !== "string") {
    throw new Error("date is required and must be a string in YYYY-MM-DD format");
  }

  // Convert date to UTC range
  const { startDate, endDate } = getDateRange(date);

  logger.info(`Fetching team activities for ${personName} on ${date}`);

  // Fetch all team activities for the date range (uses the existing, working approach)
  const allActivities = await getTeamActivities(startDate, endDate, projectFilter);

  logger.info(`Fetched ${allActivities.length} total activities`);

  // Filter activities strictly where actor === personName
  const personActivities = allActivities.filter(
    (activity) => activity.actor === personName
  );

  logger.info(`Filtered to ${personActivities.length} activities for ${personName}`);

  // If no activities, return empty result
  if (personActivities.length === 0) {
    return {
      person: personName,
      date: date,
      team: config.WORKSPACE_SLUG,
      projects: [],
    };
  }

  // Group activities by project
  const projectMap = new Map();

  for (const activity of personActivities) {
    const projectId = activity.project || "Unknown";

    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        project: projectId,
        comments: [],
        subitems: [],
        workItemStates: new Map(),
      });
    }

    const projectData = projectMap.get(projectId);

    switch (activity.type) {
      case "comment":
        projectData.comments.push({
          id: activity.workItem,
          name: activity.workItemName,
          comment: activity.comment || "",
          time: activity.time,
        });
        break;

      case "subitem":
        const existingSubitemIndex = projectData.subitems.findIndex(
          (s) => s.id === activity.workItem
        );
        const subitemData = {
          id: activity.workItem,
          name: activity.workItemName,
          parent: activity.parentWorkItem || null,
          state: activity.state || "Unknown",
          progressPercentage: activity.progress?.percentageComplete || 0,
          time: activity.updatedAt || activity.createdAt,
        };

        if (existingSubitemIndex >= 0) {
          const existing = projectData.subitems[existingSubitemIndex];
          if (new Date(subitemData.time) > new Date(existing.time)) {
            projectData.subitems[existingSubitemIndex] = subitemData;
          }
        } else {
          projectData.subitems.push(subitemData);
        }
        break;

      case "activity":
      case "work_item_snapshot":
        const workItemId = activity.workItem;
        const activityTime = new Date(activity.time || activity.updatedAt);
        const existing = projectData.workItemStates.get(workItemId);

        if (!existing || activityTime > new Date(existing.time)) {
          projectData.workItemStates.set(workItemId, {
            id: workItemId,
            name: activity.workItemName,
            state: activity.newValue || activity.state || "Unknown",
            field: activity.field,
            time: activity.time || activity.updatedAt,
          });
        }
        break;

      default:
        break;
    }
  }

  // Build final result
  const projects = [];

  for (const [projectId, projectData] of projectMap) {
    const completed = [];
    const inProgress = [];
    const blockers = [];

    // Categorize work items by their latest state
    for (const [, workItem] of projectData.workItemStates) {
      const state = workItem.state;

      if (matchesStateCategory(state, "completed")) {
        completed.push({
          id: workItem.id,
          name: workItem.name,
        });
      } else if (matchesStateCategory(state, "blocked")) {
        blockers.push({
          id: workItem.id,
          name: workItem.name,
          state: state,
        });
      } else if (matchesStateCategory(state, "inProgress")) {
        inProgress.push({
          id: workItem.id,
          name: workItem.name,
          state: state,
        });
      } else {
        // Default to in-progress for non-completed states with activity
        inProgress.push({
          id: workItem.id,
          name: workItem.name,
          state: state,
        });
      }
    }

    // Format comments (no deduplication, include all)
    const comments = projectData.comments.map((c) => ({
      id: c.id,
      name: c.name,
      comment: c.comment,
    }));

    // Format subitems
    const subitems = projectData.subitems.map((s) => ({
      id: s.id,
      name: s.name,
      parent: s.parent,
      state: s.state,
      progressPercentage: s.progressPercentage,
    }));

    projects.push({
      project: projectId,
      completed: completed,
      inProgress: inProgress,
      comments: comments,
      subitems: subitems,
      blockers: blockers,
    });
  }

  // Fetch cycle data for each project
  const projectIds = Array.from(projectMap.keys());
  const allProjects = await fetchProjects();

  // Create project lookup by identifier
  const projectLookup = new Map();
  for (const proj of allProjects) {
    projectLookup.set(proj.identifier, proj);
    projectLookup.set(proj.name, proj);
  }

  // Fetch cycles for relevant projects
  const cycleData = new Map();
  for (const projectId of projectIds) {
    const proj = projectLookup.get(projectId);
    if (proj) {
      const cycles = await fetchCycles(proj.id);
      cycleData.set(projectId, cycles);
    }
  }

  const result = {
    person: personName,
    date: date,
    team: config.WORKSPACE_SLUG,
    projects: projects.map(p => ({
      ...p,
      cycles: cycleData.get(p.project) || [],
    })),
  };

  logger.info(
    `Generated summary for ${personName}: ${projects.length} projects, ` +
    `${projects.reduce((sum, p) => sum + p.completed.length, 0)} completed, ` +
    `${projects.reduce((sum, p) => sum + p.inProgress.length, 0)} in-progress`
  );

  return result;
}

/**
 * LLM System Prompt for formatting person daily summary
 */
const PERSON_SUMMARY_SYSTEM_PROMPT = `You are a work activity formatter. Your ONLY job is to convert a structured person work summary into readable text.

STRICT RULES:
1. ONLY describe data that is explicitly provided in the summary
2. DO NOT infer intent, productivity, mood, or additional context
3. DO NOT add encouragement, opinions, praise, or commentary
4. DO NOT use marketing or emotional language
5. Use clear, professional, factual language
6. Use bullet points for clarity
7. Include work item identifiers when referencing work

OUTPUT FORMAT:
## Daily Summary for [Person] - [Date]

### Completed Work
- [List completed items with ID and name, or "No completed work" if empty]

### In Progress
- [List in-progress items with ID, name, and state, or "No work in progress" if empty]

### Comments/Discussions
- [List comments with work item reference and comment text, or "No comments" if empty]

### Sub-items
- [List subitems with ID, name, parent, state, progress %, or "No subitems" if empty]

### Blockers
- [List blocked items with ID, name, and state, or "No blockers" if empty]

### Cycle Progress
- [For each project with cycles, list: cycle name, completion percentage (completedIssues/totalIssues * 100), and whether it's current/active. Or "No active cycles" if empty]

If the person has no activity at all, respond with:
"No activity recorded for [Person] on [Date]."`;

/**
 * Generate human-readable text from a structured person daily summary
 *
 * @param {Object} summary - The structured summary object from getPersonDailySummary
 * @returns {Promise<string>} Human-readable text summary
 */
async function generatePersonDailySummaryText(summary) {
  // Validate input
  if (!summary || typeof summary !== "object") {
    throw new Error("summary is required and must be an object");
  }
  if (!summary.person || !summary.date) {
    throw new Error("summary must contain person and date fields");
  }

  logger.info(
    `Generating text summary for ${summary.person} on ${summary.date}`
  );

  // Handle empty summary case without LLM
  if (!summary.projects || summary.projects.length === 0) {
    return `No activity recorded for ${summary.person} on ${summary.date}.`;
  }

  const userPrompt = `Convert this person's daily work summary into readable text. Do NOT add any information that is not in this data.

SUMMARY DATA:
${JSON.stringify(summary, null, 2)}`;

  try {
    const result = await generateText({
      model: google(config.GEMINI_MODEL),
      system: PERSON_SUMMARY_SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: config.GEMINI_TEMPERATURE,
    });

    logger.info(
      `Generated ${result.text.length} character text summary for ${summary.person}`
    );

    return result.text;
  } catch (error) {
    logger.error(`Error generating text summary: ${error.message}`);
    throw error;
  }
}

// Cache members for autocomplete (refreshed every 5 minutes)
let membersCache = null;
let membersCacheTime = null;
const MEMBERS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get all people in the workspace for autocomplete (with caching for speed)
 * @returns {Promise<Array<{name: string, id: string}>>}
 */
async function getPeople() {
  // Return from cache if available and fresh
  if (membersCache && membersCacheTime && Date.now() - membersCacheTime < MEMBERS_CACHE_TTL_MS) {
    return membersCache;
  }

  try {
    const members = await getWorkspaceMembers();
    logger.info(`Fetched ${members.length} members from API for dropdown`);

    if (members.length === 0) {
      logger.warn("No members found in workspace");
      return [];
    }

    const people = members.map((member) => {
      const userData = member.member || member.user || member;
      const displayName =
        member.display_name ||
        userData.display_name ||
        userData.first_name ||
        userData.email ||
        "Unknown User";

      const userId = userData.id || member.id || member.member_id;

      return {
        name: displayName,
        id: userId,
      };
    }).filter(p => p.name !== "Unknown User");

    logger.debug(`Processed ${people.length} people for dropdown`, {
      sample: people.slice(0, 3).map(p => p.name)
    });

    // Update cache
    membersCache = people;
    membersCacheTime = Date.now();

    return people;
  } catch (error) {
    logger.error(`Error fetching people for dropdown: ${error.message}`, error);
    return [];
  }
}

module.exports = {
  getPersonDailySummary,
  generatePersonDailySummaryText,
  getPeople,
};
