import {
  getTeamActivities,
  getProjectMembers,
  getCyclesWithCache,
  clearActivityCaches,
  startProjectSession,
  preloadAllUsers
} from './planeApiDirect.js';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import logger from '../utils/logger.js';
import { matchesStateCategory } from '../utils/stateUtils.js';

/**
 * Normalize a name for comparison by removing special characters, converting to lowercase
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[.\-_\s]+/g, '');
}

/**
 * Check if two names match (handles different formats)
 */
function namesMatch(name1, name2) {
  if (!name1 || !name2) return false;
  return normalizeName(name1) === normalizeName(name2);
}

/**
 * Process team activities for a specific project and date range - OPTIMIZED VERSION
 * Fetches all activities ONCE then groups by member in memory
 * @param {string} projectId - Project ID
 * @param {string} projectName - Project name
 * @param {string} projectIdentifier - Project identifier
 * @param {Date} startOfDay - Start of date range
 * @param {Date} endOfDay - End of date range
 * @param {string} dateKey - Date key for logging
 * @returns {Object} Team member data with activities
 */
export async function processTeamActivities(projectId, projectName, projectIdentifier, startOfDay, endOfDay, dateKey) {
  const startTime = Date.now();

  // Start a single session for the entire operation
  startProjectSession(projectId);

  // Preload all users for fast lookup
  await preloadAllUsers();

  const members = await getProjectMembers(projectId);
  logger.info(`Found ${members.length} members in project ${projectName}`);

  // Fetch cycles in parallel with activities
  const cyclesPromise = getCyclesWithCache(projectId);

  // Members to ignore in team summaries
  const ignoredMembers = ['suhas', 'abhinav'];

  // Filter members first
  const activeMembers = members.filter(member => {
    const userData = member.member || member.user || member;
    const memberName =
      member.display_name ||
      userData.display_name ||
      userData.first_name ||
      userData.email ||
      "Unknown";

    if (memberName === "Unknown") return false;
    if (memberName && typeof memberName === 'string' &&
      ignoredMembers.some(ignored => memberName.toLowerCase().includes(ignored))) {
      logger.info(`Skipping ignored member: ${memberName}`);
      return false;
    }
    return true;
  });

  logger.info(`Processing ${activeMembers.length} active members (after filtering ${members.length - activeMembers.length} ignored)`);

  // Clear activity caches once at the start
  clearActivityCaches();

  // CRITICAL OPTIMIZATION: Fetch ALL activities for the project ONCE (no actor filter)
  // This is the key change - we fetch everything once and filter in memory
  logger.info(`🚀 OPTIMIZED: Fetching ALL activities for project ${projectIdentifier} once`);
  const allActivities = await getTeamActivities(
    startOfDay,
    endOfDay,
    projectIdentifier,
    null // NO actor filter - get ALL activities
  );

  const fetchDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info(`✅ Fetched ${allActivities.length} total activities in ${fetchDuration}s`);

  // Wait for cycles
  const cycles = await cyclesPromise;
  logger.info(`Found ${cycles.length} total cycles for project`);

  // Find active cycles for the date
  const relevantCycles = findRelevantCycles(cycles, dateKey);
  const cycleInfo = formatCycleInfo(relevantCycles);
  logger.info(`Cycle info: ${cycleInfo}`);

  // OPTIMIZATION: Group activities by actor/assignee in memory (no API calls!)
  const teamMemberData = [];

  for (const member of activeMembers) {
    const userData = member.member || member.user || member;
    const memberName =
      member.display_name ||
      userData.display_name ||
      userData.first_name ||
      userData.email ||
      "Unknown";

    // Filter activities for this member IN MEMORY (no API call!)
    const memberActivities = filterActivitiesForMember(allActivities, memberName);

    logger.debug(`Member ${memberName}: ${memberActivities.length} activities (filtered from ${allActivities.length})`);

    const { completed, inProgress, todo, comments, activityUpdates } = processActivities(memberActivities);

    if (comments.length > 0) {
      logger.debug(`Member ${memberName}: Found ${comments.length} comments`);
    }
    
    if (activityUpdates.length > 0) {
      logger.debug(`Member ${memberName}: Found ${activityUpdates.length} activity updates`);
    }

    // Add all members to the summary
    teamMemberData.push({ name: memberName, completed, inProgress, todo, comments, activityUpdates });
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info(`✅ Team member processing complete in ${totalDuration}s: ${teamMemberData.length} members with data`);

  return {
    teamMemberData,
    cycleInfo,
    projectName,
    dateKey
  };
}

/**
 * Filter activities for a specific member from the full list
 * This is done entirely in memory - no API calls!
 * 
 * Matches activities where:
 * 1. Member is the actor (for activities/comments)
 * 2. Member is in assignees (for work_item_snapshot/subitem)
 * 3. Member is the creator (for creation activities - verb: "created")
 */
function filterActivitiesForMember(allActivities, memberName) {
  const memberActivities = [];

  for (const activity of allActivities) {
    // For activities and comments: check if actor matches
    if (activity.type === "activity" || activity.type === "comment") {
      if (namesMatch(activity.actor, memberName)) {
        memberActivities.push(activity);
      }
    }
    // For work_item_snapshot: check if member is in assignees OR is the creator
    else if (activity.type === "work_item_snapshot") {
      const isAssignee = activity.assignees && activity.assignees.some(a => namesMatch(a, memberName));
      const isCreator = activity.createdBy && namesMatch(activity.createdBy, memberName);
      if (isAssignee || isCreator) {
        memberActivities.push(activity);
      }
    }
    // For subitems: check if member is in assignees
    else if (activity.type === "subitem") {
      if (activity.assignees && activity.assignees.some(a => namesMatch(a, memberName))) {
        memberActivities.push(activity);
      }
    }
  }

  return memberActivities;
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
 * Process raw activities into categorized data
 * @param {Array} activities - Raw activities from API
 * @returns {Object} Categorized activities { completed: [], inProgress: [], todo: [], comments: [] }
 */
function processActivities(activities) {
  const completed = [];
  const inProgress = [];
  const todo = [];
  const workItemStates = new Map();
  const workItemRelationships = new Map();
  const comments = [];
  const activityUpdates = [];

  for (const activity of activities) {
    const workItemId = activity.workItem;
    const workItemName = activity.workItemName;

    if (activity.relationships) {
      if (!workItemRelationships.has(workItemId)) {
        workItemRelationships.set(workItemId, activity.relationships);
      } else {
        const existing = workItemRelationships.get(workItemId);
        workItemRelationships.set(workItemId, { ...existing, ...activity.relationships });
      }
    }

    if (activity.field === "assignees" || activity.field === "assignee") {
      logger.debug(`Skipping assignment-only activity for ${workItemId}`);
      continue;
    }

    if (activity.type === "activity" || activity.type === "work_item_snapshot") {
      const verb = activity.verb || "updated";
      const field = activity.field || "";
      
      const isCreation = verb === "created" || field === "created";
      const isCycleChange = field === "cycle" || field === "cycles";
      const isStateChange = field === "state" || field === "status";
      
      if (isCreation || isCycleChange || isStateChange) {
        const updateKey = `${workItemId}-${field}-${verb}`;
        const existingUpdate = activityUpdates.find(u => u.key === updateKey);
        
        if (!existingUpdate) {
          let action = "";
          if (isCreation) {
            action = "created";
          } else if (isCycleChange) {
            action = activity.newValue ? `added to ${activity.newValue}` : "updated cycle";
          } else if (isStateChange) {
            action = `changed to ${activity.newValue || activity.state || "Unknown"}`;
          }
          
          activityUpdates.push({
            key: updateKey,
            id: workItemId,
            name: workItemName,
            action: action,
            actor: activity.actor,
            time: activity.time || activity.updatedAt,
            relationships: activity.relationships,
            state: activity.state || activity.newValue || "Unknown"
          });
        }
      }
      
      const state = isStateChange
        ? (activity.newValue || activity.state || "Unknown")
        : (activity.state || activity.newValue || "Unknown");

      const activityTime = new Date(activity.time || activity.updatedAt);
      const existing = workItemStates.get(workItemId);

      if (!existing || activityTime > new Date(existing.time)) {
        workItemStates.set(workItemId, {
          id: workItemId,
          name: workItemName,
          state: state,
          time: activity.time || activity.updatedAt,
          relationships: activity.relationships,
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
          relationships: activity.relationships,
        });

        // Update work item state based on current state (from activity.state)
        const currentState = activity.state || "Unknown";
        const activityTime = new Date(activity.time);
        const existing = workItemStates.get(workItemId);

        // Update state if this is the most recent activity
        if (!existing || activityTime > new Date(existing.time)) {
          workItemStates.set(workItemId, {
            id: workItemId,
            name: workItemName,
            state: currentState,
            time: activity.time,
            relationships: activity.relationships,
          });
        }
      }
    } else if (activity.type === "subitem") {
      const subState = activity.state || "Unknown";
      if (matchesStateCategory(subState, "completed")) {
        if (!completed.find((c) => c.id === workItemId)) {
          completed.push({
            id: workItemId,
            name: workItemName,
            relationships: activity.relationships
          });
        }
      } else {
        if (!inProgress.find((c) => c.id === workItemId)) {
          inProgress.push({
            id: workItemId,
            name: workItemName,
            state: subState,
            relationships: activity.relationships
          });
        }
      }
    }
  }

  // Process work item states into three categories: done, inprogress, todo
  for (const [, workItem] of workItemStates) {
    const relationships = workItemRelationships.get(workItem.id) || workItem.relationships || {};

    if (matchesStateCategory(workItem.state, "completed")) {
      if (!completed.find((c) => c.id === workItem.id)) {
        completed.push({
          id: workItem.id,
          name: workItem.name,
          relationships: relationships
        });
      }
    } else if (matchesStateCategory(workItem.state, "inProgress")) {
      if (!inProgress.find((c) => c.id === workItem.id)) {
        inProgress.push({
          id: workItem.id,
          name: workItem.name,
          state: workItem.state,
          relationships: relationships
        });
      }
    } else {
      // Everything else goes to todo (backlog, blocked, unknown states)
      if (!todo.find((c) => c.id === workItem.id) &&
        !completed.find((c) => c.id === workItem.id) &&
        !inProgress.find((c) => c.id === workItem.id)) {
        let displayState = workItem.state;
        if (matchesStateCategory(workItem.state, "blocked")) {
          displayState = "Blocked";
        } else if (matchesStateCategory(workItem.state, "backlog")) {
          displayState = "Todo";
        } else {
          displayState = "Todo"; // Default unknown states to Todo
        }

        todo.push({
          id: workItem.id,
          name: workItem.name,
          state: displayState,
          relationships: relationships
        });
      }
    }
  }

  return { completed, inProgress, todo, comments, activityUpdates };
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
        ? member.completed.map((t) => {
          const relText = formatRelationships(t.relationships);
          return `  • ${t.id}: ${t.name}${relText}`;
        }).join("\n")
        : "  None";

      const inProgressText = member.inProgress.length > 0
        ? member.inProgress.map((t) => {
          const relText = formatRelationships(t.relationships);
          return `  • ${t.id}: ${t.name} (${t.state})${relText}`;
        }).join("\n")
        : "  None";

      const todoText = member.todo?.length > 0
        ? member.todo.map((t) => {
          const relText = formatRelationships(t.relationships);
          return `  • ${t.id}: ${t.name} (${t.state})${relText}`;
        }).join("\n")
        : "  None";

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
            const task = member.inProgress.find((t) => t.id === taskId) ||
              member.completed.find((t) => t.id === taskId) ||
              member.todo?.find((t) => t.id === taskId);
            const taskName = task?.name || taskId;
            const relText = task?.relationships ? formatRelationships(task.relationships) : "";
            return `  • ${taskId}: ${commentList[0]}${relText}`;
          })
          .join("\n")
        : "  None";

      return `MEMBER: ${member.name}\nCOMPLETED:\n${completedText}\nIN_PROGRESS:\n${inProgressText}\nTODO:\n${todoText}\nCOMMENTS:\n${commentsText}`;
    })
    .join("\n\n");
}

/**
 * Format relationship information for display
 * @param {Object} relationships - Relationship object
 * @returns {string} Formatted relationship text
 */
function formatRelationships(relationships) {
  if (!relationships || Object.keys(relationships).length === 0) {
    return "";
  }

  const relParts = [];
  Object.entries(relationships).forEach(([type, data]) => {
    if (data && data.value) {
      relParts.push(`${type}: ${data.value}`);
    }
  });

  return relParts.length > 0 ? ` [${relParts.join(", ")}]` : "";
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
7. Include relationship information ONLY when it appears in brackets after task names (e.g., relates_to: SLMRA-35)
8. If a member has no completed tasks, no in-progress tasks, no comments, and no todo items, do not include them.
9. DO NOT add relationship brackets if no relationship information is provided

OUTPUT FORMAT:

**PROJECT_NAME**
CYCLE_NAME -> X% completed

**TEAM_MEMBER_A**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name
• TASK-ID: Task Name [relates_to: TASK-ID]

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)
• TASK-ID: Task Name (State) [relates_to: TASK-ID]

**Tasks/SubTasks Todo:**
• TASK-ID: Task Name (State)
• TASK-ID: Task Name (State) [relates_to: TASK-ID]

**Comments/Updates:**
• TASK-ID: Brief comment summary
• TASK-ID: Brief comment summary [relates_to: TASK-ID]

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
    model: google(env.GEMINI_MODEL || "gemini-2.5-flash"),
    system: systemPrompt,
    prompt: userPrompt,
    temperature: env.GEMINI_TEMPERATURE || 0.3,
  });

  return result.text;
}
