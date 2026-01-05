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

  const personActivities = await getTeamActivities(startDate, endDate, projectFilter, personName);

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
      cycles: [], // Will be filled with cycle data below
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
      const allCycles = await fetchCycles(proj.id);
      // Filter for active or current cycles only to avoid clutter
      const activeCycles = allCycles.filter(c => c.is_current || c.state === 'started');
      cycleData.set(projectId, activeCycles);
    }
  }

  // Enhance projects with cycle details and calculated completion percentages
  const enhancedProjects = projects.map(p => {
    const cycles = cycleData.get(p.project) || [];
    const cyclesWithCompletion = cycles.map(cycle => {
      const totalIssues = (cycle.total_issues || 0);
      const completedIssues = (cycle.completed_issues || 0);
      const percentageComplete = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
      return {
        name: cycle.name,
        status: cycle.state || 'started',
        total_issues: totalIssues,
        completed_issues: completedIssues,
        percentage_complete: percentageComplete,
      };
    });
    return {
      ...p,
      cycles: cyclesWithCompletion,
    };
  });

  return {
    person: personName,
    date,
    team: workspaceSlug || "Workspace",
    projects: enhancedProjects,
  };
}

const PERSON_SUMMARY_SYSTEM_PROMPT = `You are a work activity formatter. Your ONLY job is to convert a structured person work summary into the EXACT format specified below.

STRICT RULES:
1. Output ONLY the exact format shown - no deviations
2. Include ALL projects, cycles, and tasks provided in the data
3. DO NOT add explanations, commentary, or inferred information
4. Use bullet points (•) for task lists
5. Use the exact field values provided - do not modify or summarize
6. Show completion percentages exactly as provided

OUTPUT FORMAT (for each project):
Project Name
Cycle Name - Cycle Status -> X% completed

Person Name

Tasks/SubTasks Done:
• TASK-ID: Task Name
• SUBTASK-ID: Subtask Name
(empty if none)

Tasks/SubTasks in Progress:
• TASK-ID: Task Name (State)
• SUBTASK-ID: Subtask Name (State)
(empty if none)

INSTRUCTIONS:
1. For each project in the data, create a new section
2. Show the project name exactly as provided
3. For cycles: use the cycle name and status from the data. Completion percentage is provided as 'percentage_complete'
4. Use the person's name exactly as provided
5. List all completed work items and subtasks under "Tasks/SubTasks Done"
6. List all in-progress work items and subtasks under "Tasks/SubTasks in Progress"
7. Format: ID: Name (State) for in-progress items
8. Separate sections with blank lines
9. If no activities exist, respond with: "No activity recorded for [Person] on [Date]."`;

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
      prompt: `Format this person's daily work summary exactly according to the format specification. Use ALL data provided. Do not omit, summarize, or modify any values.\n\nPERSON: ${summary.person}\nDATE: ${summary.date}\nWORKSPACE: ${summary.team}\n\nWORK DATA:\n${JSON.stringify(summary.projects, null, 2)}\n\nGenerate the formatted output now:`,
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
