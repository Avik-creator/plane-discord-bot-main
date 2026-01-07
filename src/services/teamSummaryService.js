import {
  getTeamActivities,
  fetchProjects,
  getProjectMembers,
  getCyclesWithCache,
  clearActivityCaches
} from './planeApiDirect.js';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import logger from '../utils/logger.js';
import { matchesStateCategory } from '../utils/stateUtils.js';

/**
 * Process team activities for a specific project and date range
 * @param {string} projectId - Project ID
 * @param {string} projectName - Project name
 * @param {string} projectIdentifier - Project identifier
 * @param {Date} startOfDay - Start of date range
 * @param {Date} endOfDay - End of date range
 * @param {string} dateKey - Date key for logging
 * @returns {Object} Team member data with activities
 */
export async function processTeamActivities(projectId, projectName, projectIdentifier, startOfDay, endOfDay, dateKey) {
  const members = await getProjectMembers(projectId);
  logger.info(`Found ${members.length} members in project ${projectName}`);

  const cycles = await getCyclesWithCache(projectId);
  logger.info(`Found ${cycles.length} total cycles for project`);

  // Find active cycles for the date
  const relevantCycles = findRelevantCycles(cycles, dateKey);
  const cycleInfo = formatCycleInfo(relevantCycles);
  logger.info(`Cycle info: ${cycleInfo}`);

  // Clear caches for fresh data
  clearActivityCaches();

  // Get activities for each team member
  const teamMemberData = [];
  logger.info(`Processing ${members.length} team members for activities on ${dateKey}`);

  // Members to ignore in team summaries
  const ignoredMembers = ['suhas', 'abhinav'];

  for (const member of members) {
    const memberData = await processMemberActivities(
      member,
      startOfDay,
      endOfDay,
      projectIdentifier,
      dateKey,
      ignoredMembers
    );

    if (memberData) {
      teamMemberData.push(memberData);
    }
  }

  logger.info(`Team member processing complete: ${teamMemberData.length} members with data`);

  return {
    teamMemberData,
    cycleInfo,
    projectName,
    dateKey
  };
}

/**
 * Find cycles that are relevant for a given date
 * @param {Array} cycles - All cycles for the project
 * @param {string} dateKey - Date string in YYYY-MM-DD format
 * @returns {Array} Relevant cycles
 */
function findRelevantCycles(cycles, dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const queryDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  return cycles.filter((c) => {
    if (!c.startDate || !c.endDate) {
      logger.debug(`Cycle ${c.name} has no dates, skipping`);
      return false;
    }
    const cycleStart = new Date(c.startDate);
    const cycleEnd = new Date(c.endDate);

    // Compare just the dates (ignore time)
    const cycleStartDate = new Date(cycleStart.getUTCFullYear(), cycleStart.getUTCMonth(), cycleStart.getUTCDate());
    const cycleEndDate = new Date(cycleEnd.getUTCFullYear(), cycleEnd.getUTCMonth(), cycleEnd.getUTCDate());
    const queryDateLocal = new Date(queryDate.getUTCFullYear(), queryDate.getUTCMonth(), queryDate.getUTCDate());

    const isInRange = queryDateLocal >= cycleStartDate && queryDateLocal <= cycleEndDate;
    logger.info(`Cycle "${c.name}": ${c.startDate} to ${c.endDate}, query date ${dateKey}, in range: ${isInRange}`);
    return isInRange;
  });
}

/**
 * Format cycle information for display
 * @param {Array} cycles - Relevant cycles
 * @returns {string} Formatted cycle info
 */
function formatCycleInfo(cycles) {
  if (cycles.length === 0) {
    return "No active cycles";
  }

  return cycles
    .map((c) => {
      const totalIssues = c.totalIssues || 0;
      const completedIssues = c.completedIssues || 0;
      const percentage = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
      return `${c.name} -> ${percentage}% completed`;
    })
    .join("\n");
}

/**
 * Process activities for a single team member
 * @param {Object} member - Member object from API
 * @param {Date} startOfDay - Start of date range
 * @param {Date} endOfDay - End of date range
 * @param {string} projectIdentifier - Project identifier
 * @param {string} dateKey - Date key for logging
 * @param {Array} ignoredMembers - List of members to ignore
 * @returns {Object|null} Member data with activities or null if skipped
 */
async function processMemberActivities(member, startOfDay, endOfDay, projectIdentifier, dateKey, ignoredMembers) {
  const userData = member.member || member.user || member;
  const memberName =
    member.display_name ||
    userData.display_name ||
    userData.first_name ||
    userData.email ||
    "Unknown";

  if (memberName === "Unknown") {
    logger.warn(`Skipping member with Unknown name`);
    return null;
  }

  // Skip ignored members
  if (memberName && typeof memberName === 'string' &&
    ignoredMembers.some(ignored => memberName.toLowerCase().includes(ignored))) {
    logger.info(`Skipping ignored member: ${memberName}`);
    return null;
  }

  logger.info(`Processing member: ${memberName}`);

  try {
    const personActivities = await getTeamActivities(
      startOfDay,
      endOfDay,
      projectIdentifier,
      memberName
    );

    // Continue processing even if no activities for this date
    logger.info(`Member ${memberName}: ${personActivities.length} activities on ${dateKey}`);

    const { completed, inProgress, comments } = processActivities(personActivities);

    // Log comment count for debugging
    if (comments.length > 0) {
      logger.info(`Member ${memberName}: Found ${comments.length} comments`);
    }

    // Add all members to the summary, even if they have no activity
    return { name: memberName, completed, inProgress, comments };

  } catch (error) {
    logger.warn(`Error fetching activities for ${memberName}: ${error.message}`);
    return null;
  }
}

/**
 * Process raw activities into categorized data
 * @param {Array} activities - Raw activities from API
 * @returns {Object} Categorized activities { completed: [], inProgress: [], comments: [] }
 */
function processActivities(activities) {
  const completed = [];
  const inProgress = [];
  const workItemStates = new Map();
  const comments = []; // Store comments for progress tracking

  for (const activity of activities) {
    const workItemId = activity.workItem;
    const workItemName = activity.workItemName;

    if (activity.field === "assignees" || activity.field === "assignee") {
      logger.debug(`Skipping assignment-only activity for ${workItemId}`);
      continue;
    }

    if (activity.type === "activity" || activity.type === "work_item_snapshot") {
      const state = activity.newValue || activity.state || "Unknown";
      const activityTime = new Date(activity.time || activity.updatedAt);
      const existing = workItemStates.get(workItemId);

      if (!existing || activityTime > new Date(existing.time)) {
        workItemStates.set(workItemId, {
          id: workItemId,
          name: workItemName,
          state: state,
          time: activity.time || activity.updatedAt,
        });
      }
    } else if (activity.type === "comment") {
      // Extract comment text - handle both stripped and HTML formats
      const commentText = activity.comment || "";
      logger.debug(`Processing comment on ${workItemId}: text length=${commentText.length}, actor=${activity.actor}`);
      if (commentText.trim().length > 0) {
        // Truncate long comments to 100 chars for summary
        const truncatedComment = commentText.length > 200
          ? commentText.substring(0, 100) + "..."
          : commentText;

        logger.debug(`✓ Adding comment to ${workItemId}: "${truncatedComment}"`);
        comments.push({
          id: workItemId,
          name: workItemName,
          comment: truncatedComment,
          actor: activity.actor,
          time: activity.time,
        });

        // Track work item with comment as in-progress (unless already marked as completed)
        if (!completed.find((c) => c.id === workItemId)) {
          const existing = inProgress.find((c) => c.id === workItemId);
          if (!existing) {
            inProgress.push({
              id: workItemId,
              name: workItemName,
              state: "In Progress (Updated via comment)",
              hasComments: true,
            });
          }
        }
      }
    } else if (activity.type === "subitem") {
      const subState = activity.state || "Unknown";
      if (matchesStateCategory(subState, "completed")) {
        if (!completed.find((c) => c.id === workItemId)) {
          completed.push({ id: workItemId, name: workItemName });
        }
      } else {
        if (!inProgress.find((c) => c.id === workItemId)) {
          inProgress.push({ id: workItemId, name: workItemName, state: subState });
        }
      }
    }
  }

  // Process work item states
  for (const [, workItem] of workItemStates) {
    if (matchesStateCategory(workItem.state, "completed")) {
      if (!completed.find((c) => c.id === workItem.id)) {
        completed.push({ id: workItem.id, name: workItem.name });
      }
    } else {
      if (!inProgress.find((c) => c.id === workItem.id)) {
        inProgress.push({
          id: workItem.id,
          name: workItem.name,
          state: workItem.state,
        });
      }
    }
  }

  return { completed, inProgress, comments };
}

/**
 * Format team data for AI processing
 * @param {Array} teamMemberData - Team member data
 * @returns {string} Formatted data string
 */
export function formatTeamDataForAI(teamMemberData) {
  return teamMemberData
    .map((member) => {
      const completedText = member.completed.length > 0
        ? member.completed.map((t) => `  • ${t.id}: ${t.name}`).join("\n")
        : "  None";
      const inProgressText = member.inProgress.length > 0
        ? member.inProgress.map((t) => `  • ${t.id}: ${t.name} (${t.state})`).join("\n")
        : "  None";

      // Format comments - extract unique comments by task
      const commentsByTask = {};
      member.comments?.forEach((comment) => {
        if (!commentsByTask[comment.id]) {
          commentsByTask[comment.id] = [];
        }
        commentsByTask[comment.id].push(comment.comment);
      });

      const commentsText = Object.keys(commentsByTask).length > 0
        ? Object.entries(commentsByTask)
          .map(([taskId, commentList]) => {
            const taskName = member.inProgress.find((t) => t.id === taskId)?.name ||
              member.completed.find((t) => t.id === taskId)?.name ||
              taskId;
            return `  • ${taskId}: ${commentList[0]}`; // Use first comment as summary
          })
          .join("\n")
        : "  None";

      return `MEMBER: ${member.name}\nCOMPLETED:\n${completedText}\nIN_PROGRESS:\n${inProgressText}\nCOMMENTS:\n${commentsText}`;
    })
    .join("\n\n");
}

/**
 * Generate AI summary for team data
 * @param {string} formattedTeamData - Formatted team data
 * @param {string} projectName - Project name
 * @param {string} dateKey - Date key
 * @param {string} cycleInfo - Cycle information
 * @param {Object} env - Environment variables
 * @returns {string} AI-generated summary
 */
export async function generateTeamSummary(formattedTeamData, projectName, dateKey, cycleInfo, env) {
  const systemPrompt = `You are a team work summary formatter. Your ONLY job is to convert structured team work data into readable text using a SPECIFIC format.

STRICT RULES:
1. ONLY describe activities that are explicitly provided in the data
2. DO NOT infer intent, mood, or additional context
3. DO NOT add encouragement, opinions, or commentary
4. Use clear, professional language
5. Follow the EXACT output format below
6. Include comments showing progress updates on tasks (e.g., "Updated via comment: task description")

OUTPUT FORMAT:

**PROJECT_NAME**
CYCLE_NAME -> X% completed

**TEAM_MEMBER_A**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name
[or "None" if no completed items]

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)
[or "None" if no in-progress items]

**Comments/Updates:**
• TASK-ID: Brief comment summary
[or "None" if no comments]

**TEAM_MEMBER_B**

[Continue for all team members...]

---
`;

  const userPrompt = `Format this team daily summary for ${dateKey} using the exact format specified. Include comments as they show progress on tasks even when there are no formal state changes.
PROJECT: ${projectName}
CYCLE INFO: ${cycleInfo}

TEAM MEMBERS DATA:
${formattedTeamData}`;

  const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
  const result = await generateText({
    model: google(env.GEMINI_MODEL || "gemini-1.5-flash"),
    system: systemPrompt,
    prompt: userPrompt,
    temperature: env.GEMINI_TEMPERATURE || 0.3,
  });

  return result.text;
}
