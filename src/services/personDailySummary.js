import {
  getTeamActivities,
  getWorkspaceMembers,
  fetchProjects,
  getCyclesWithCache
} from "./planeApiDirect.js";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import logger from "../utils/logger.js";
import { matchesStateCategory } from "../utils/stateUtils.js";

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
        blockers.push({ id: workItem.id, name: workItem.name, state: "Blocked" });
      } else {
        // Normalize state display for inProgress items
        let displayState = state;
        if (matchesStateCategory(state, "backlog")) {
          displayState = "Backlog";
        } else if (matchesStateCategory(state, "inProgress")) {
          displayState = state; // Keep original in-progress states
        } else {
          displayState = "Backlog"; // Default unknown states to Backlog
        }
        inProgress.push({ id: workItem.id, name: workItem.name, state: displayState });
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

  // Use the queried date to find the relevant cycle, not today's date
  // Parse date string (YYYY-MM-DD) as UTC start of day
  const [year, month, day] = date.split('-').map(Number);
  const queryDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  const cycleData = new Map();
  for (const projectId of projectIds) {
    const proj = projectLookup.get(projectId);
    if (proj) {
      const allCycles = await getCyclesWithCache(proj.id);

      // Debug: log all cycles
      logger.info(`Project ${projectId} has ${allCycles.length} total cycles`);
      if (allCycles.length > 0) {
        logger.info(`All cycles: ${JSON.stringify(allCycles.map(c => ({
          name: c.name,
          startDate: c.startDate,
          endDate: c.endDate,
          totalIssues: c.totalIssues,
          completedIssues: c.completedIssues
        })))}`);
      }

      // Filter for cycles that contain the queried date
      const relevantCycles = allCycles.filter(c => {
        if (!c.startDate || !c.endDate) {
          logger.debug(`Cycle ${c.name} has no start/end date, skipping date-based match`);
          return false;
        }
        const cycleStart = new Date(c.startDate);
        const cycleEnd = new Date(c.endDate);

        // Compare dates (ignore time portion) - check if queryDate falls within cycle range
        const cycleStartDate = new Date(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth(), cycleStart.getUTCDate());
        const cycleEndDate = new Date(cycleEnd.getUTCFullYear(), cycleEnd.getUTCMonth(), cycleEnd.getUTCDate());
        const queryDateLocal = new Date(queryDate.getUTCFullYear(), queryDate.getUTCMonth(), queryDate.getUTCDate());

        const isInRange = queryDateLocal >= cycleStartDate && queryDateLocal <= cycleEndDate;
        logger.debug(`Cycle ${c.name}: ${c.startDate} to ${c.endDate}, queryDate ${date}, inRange: ${isInRange}`);
        return isInRange;
      });

      // If no cycles matched by date, try matching work items to cycles
      if (relevantCycles.length === 0 && allCycles.length > 0) {
        logger.info(`No cycles matched by date range for ${projectId}, checking work items for cycle hints`);

        // Get work items for this project from personActivities
        const projectActivities = personActivities.filter(a => a.project === projectId);
        const mentionedCycleNames = new Set();

        // Look for patterns like "Week X" in work items
        for (const activity of projectActivities) {
          if (activity.workItemName && activity.workItemName.includes('Week')) {
            const weekMatch = activity.workItemName.match(/Week\s+(\d+)/i);
            if (weekMatch) {
              mentionedCycleNames.add(`Week ${weekMatch[1]}`);
            }
          }
        }

        // Match cycles by name if we found cycle hints
        if (mentionedCycleNames.size > 0) {
          const cyclesByName = allCycles.filter(c => mentionedCycleNames.has(c.name));
          logger.info(`Found cycles by name matching work items: ${JSON.stringify(cyclesByName.map(c => c.name))}`);
          cycleData.set(projectId, cyclesByName);
          continue;
        }
      }

      logger.info(`Project ${projectId} relevant cycles for date ${date}: ${JSON.stringify(relevantCycles.map(c => ({ name: c.name, startDate: c.startDate, endDate: c.endDate })))}`);
      cycleData.set(projectId, relevantCycles);
    }
  }

  // Enhance projects with cycle details and calculated completion percentages
  const enhancedProjects = projects.map(p => {
    const cycles = cycleData.get(p.project) || [];
    const cyclesWithCompletion = cycles.map(cycle => {
      const totalIssues = cycle.totalIssues || 0;
      const completedIssues = cycle.completedIssues || 0;
      const percentageComplete = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
      return {
        name: cycle.name,
        status: cycle.isCurrent ? 'Current' : (cycle.isActive ? 'Active' : 'Completed'),
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

**Project Name**
[Cycle information - see below]

**Person Name**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name
[or "None" if no completed items]

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)
[or "None" if no in-progress items]

CYCLE FORMAT:
- If cycles array has items: display each cycle as "Cycle Name -> X% completed" on separate lines
- Example: Week 16 -> 43% completed
- If cycles array is empty: display "No cycles recorded / Found for this project."

INSTRUCTIONS:
1. For each project in the data, create a new section
2. Show the project name in bold exactly as provided
3. For cycles: show each cycle name with arrow and percentage. Percentage comes from percentage_complete field
4. Use the person's name in bold exactly as provided
5. List all completed work items and subtasks under "Tasks/SubTasks Done" using format: ID: Name
6. List all in-progress work items and subtasks under "Tasks/SubTasks in Progress" using format: ID: Name (State)
7. Include subitems in appropriate section based on their state
8. If no activities exist, respond with: "No activity recorded for [Person] on [Date]."`;

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
