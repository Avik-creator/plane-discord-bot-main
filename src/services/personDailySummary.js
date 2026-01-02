import {
  getTeamActivities,
  getWorkspaceMembers,
  fetchProjects,
  fetchCycles
} from "./planeApiDirect.js";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import logger from "../utils/logger.js";

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
 */
function matchesStateCategory(state, category) {
  if (!state || typeof state !== "string") return false;
  const stateLower = state.toLowerCase();
  const patterns = STATE_PATTERNS[category] || [];
  return patterns.some((pattern) => stateLower.includes(pattern));
}

/**
 * Convert a date string (YYYY-MM-DD) to UTC start/end range
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
 */
export async function getPersonDailySummary({
  personName,
  date,
  projectFilter = null,
  workspaceSlug = null // Now optional/passed in
}) {
  logger.info(
    `Generating person daily summary for ${personName} on ${date}${projectFilter ? ` (project: ${projectFilter})` : ""}`
  );

  const { startDate, endDate } = getDateRange(date);

  const allActivities = await getTeamActivities(startDate, endDate, projectFilter);

  const personActivities = allActivities.filter(
    (activity) => activity.actor === personName
  );

  if (personActivities.length === 0) {
    return {
      person: personName,
      date: date,
      team: workspaceSlug || "Workspace",
      projects: [],
    };
  }

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

  const projects = [];

  for (const [projectId, projectData] of projectMap) {
    const completed = [];
    const inProgress = [];
    const blockers = [];

    for (const [, workItem] of projectData.workItemStates) {
      const state = workItem.state;

      if (matchesStateCategory(state, "completed")) {
        completed.push({ id: workItem.id, name: workItem.name });
      } else if (matchesStateCategory(state, "blocked")) {
        blockers.push({ id: workItem.id, name: workItem.name, state: state });
      } else {
        inProgress.push({ id: workItem.id, name: workItem.name, state: state });
      }
    }

    projects.push({
      project: projectId,
      completed,
      inProgress,
      comments: projectData.comments.map(c => ({ id: c.id, name: c.name, comment: c.comment })),
      subitems: projectData.subitems.map(s => ({ id: s.id, name: s.name, parent: s.parent, state: s.state, progressPercentage: s.progressPercentage })),
      blockers,
    });
  }

  const projectIds = Array.from(projectMap.keys());
  const allProjects = await fetchProjects();
  const projectLookup = new Map();
  for (const proj of allProjects) {
    projectLookup.set(proj.identifier, proj);
    projectLookup.set(proj.name, proj);
  }

  const cycleData = new Map();
  for (const projectId of projectIds) {
    const proj = projectLookup.get(projectId);
    if (proj) {
      const cycles = await fetchCycles(proj.id);
      cycleData.set(projectId, cycles);
    }
  }

  return {
    person: personName,
    date,
    team: workspaceSlug || "Workspace",
    projects: projects.map(p => ({
      ...p,
      cycles: cycleData.get(p.project) || [],
    })),
  };
}

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
 */
export async function generatePersonDailySummaryText(summary, env = {}) {
  if (!summary.person || !summary.date) {
    throw new Error("summary must contain person and date fields");
  }

  if (!summary.projects || summary.projects.length === 0) {
    return `No activity recorded for ${summary.person} on ${summary.date}.`;
  }

  const modelName = env.GEMINI_MODEL || "gemini-1.5-flash";
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;

  try {
    const google = createGoogleGenerativeAI({ apiKey });

    const result = await generateText({
      model: google(modelName),
      system: PERSON_SUMMARY_SYSTEM_PROMPT,
      prompt: `Convert this person's daily work summary into readable text. Do NOT add any information that is not in this data.\n\nSUMMARY DATA:\n${JSON.stringify(summary, null, 2)}`,
      temperature: env.GEMINI_TEMPERATURE || 0.3,
    });

    return result.text;
  } catch (error) {
    logger.error(`Error generating text summary: ${error.message}`);
    throw error;
  }
}

let membersCache = null;
let membersCacheTime = null;
const MEMBERS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get all people in the workspace for autocomplete
 */
export async function getPeople() {
  if (membersCache && Date.now() - membersCacheTime < MEMBERS_CACHE_TTL_MS) {
    return membersCache;
  }

  try {
    const members = await getWorkspaceMembers();
    const people = members.map((member) => {
      const userData = member.member || member.user || member;
      const displayName = member.display_name || userData.display_name || userData.first_name || userData.email || "Unknown User";
      const userId = userData.id || member.id || member.member_id;
      return { name: displayName, id: userId };
    }).filter(p => p.name !== "Unknown User");

    membersCache = people;
    membersCacheTime = Date.now();
    return people;
  } catch (error) {
    logger.error(`Error fetching people for dropdown: ${error.message}`, error);
    return [];
  }
}
