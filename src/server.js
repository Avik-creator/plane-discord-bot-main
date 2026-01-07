import { Router } from 'itty-router';
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';
import { getPeople, getPersonDailySummary, generatePersonDailySummaryText } from './services/personDailySummary.js';
import { initPlaneService, fetchProjects, getWorkspaceMembers, getProjectMembers, getTeamActivities, getCyclesWithCache, clearActivityCaches } from './services/planeApiDirect.js';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import logger from './utils/logger.js';

//https://plane-discord-bot.abhinav-103.workers.dev

const router = Router();

/**
 * PING Handshake
 */
router.get('/', () => new Response('Plane Discord Bot is running!'));

/**
 * Send a follow-up message (internal)
 */
async function sendFollowUp(applicationId, interactionToken, payload) {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to send follow-up: ${response.status} ${errorText}`);
    }
  } catch (error) {
    logger.error(`Error sending follow-up: ${error.message}`);
  }
}

/**
 * Parse AI text into Embed sections
 */
function parseSummaryToEmbed(personName, date, text, workspaceSlug) {
  const sections = text.split(/###\s+/);
  const fields = [];
  let description = `Daily Summary for **${personName}** - **${date}**\n`;

  // First element is usually the "## Daily Summary..." header or empty
  // Header look for: ## Daily Summary for avik.mukherjee - 2026-01-02
  const mainTitleMatch = sections[0].match(/##\s+Daily Summary for\s+(.*?)\s+-\s+(.*)/);

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const lines = section.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();

    if (title && content) {
      fields.push({
        name: title,
        value: content.length > 1024 ? content.substring(0, 1021) + '...' : content,
        inline: false
      });
    }
  }

  // If no fields found, use the raw text as description
  if (fields.length === 0) {
    description = text;
  }

  return {
    embeds: [{
      title: `📊 Daily Summary: ${personName} (${date})`,
      description: description,
      color: 0x3498db, // Nice blue color
      fields: fields,
      footer: {
        text: `Team: ${workspaceSlug || 'Plane'} • Today at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      },
      timestamp: new Date().toISOString()
    }]
  };
}

/**
 * Process the command asynchronously
 */
async function processPersonDailySummary(interaction, env) {
  const { options, application_id, token } = interaction;
  // itty-router might wrap data differently
  const app_id = application_id || interaction.application_id;
  const interaction_token = token || interaction.token;

  const interactionData = interaction.data || {};
  const commandOptions = interactionData.options || [];

  const personName = commandOptions.find(o => o.name === 'person')?.value;
  const date = commandOptions.find(o => o.name === 'date')?.value || new Date().toISOString().split('T')[0];
  const projectFilter = commandOptions.find(o => o.name === 'team')?.value;

  try {
    logger.info(`Processing summary for ${personName} on ${date}`);

    const summary = await getPersonDailySummary({
      personName,
      date,
      projectFilter,
      workspaceSlug: env.WORKSPACE_SLUG
    });

    const text = await generatePersonDailySummaryText(summary, env);

    const embedPayload = parseSummaryToEmbed(personName, date, text, env.WORKSPACE_SLUG);

    await sendFollowUp(app_id, interaction_token, embedPayload);
    logger.info('Summary sent successfully');

  } catch (error) {
    logger.error(`Error generating summary: ${error.message}`, error);
    await sendFollowUp(app_id, interaction_token, {
      content: `❌ **Error generating summary**\n\n${error.message}`
    });
  }
}

/**
 * State detection patterns (case-insensitive)
 */
const STATE_PATTERNS = {
  completed: ["done", "closed", "complete", "completed"],
  blocked: ["block", "blocked", "blocking"],
  inProgress: ["progress", "in progress", "review", "active", "working"],
};

function matchesStateCategory(state, category) {
  if (!state || typeof state !== "string") return false;
  const stateLower = state.toLowerCase();
  const patterns = STATE_PATTERNS[category] || [];
  return patterns.some((pattern) => stateLower.includes(pattern));
}

/**
 * Process Team Daily Summary Command
 */
async function processTeamDailySummary(interaction, env) {
  const { application_id, token } = interaction;
  const app_id = application_id || interaction.application_id;
  const interaction_token = token || interaction.token;

  const interactionData = interaction.data || {};
  const commandOptions = interactionData.options || [];

  const projectFilter = commandOptions.find(o => o.name === 'project')?.value;
  const dateInput = commandOptions.find(o => o.name === 'date')?.value;

  try {
    // Parse date
    let targetDate = new Date();
    if (dateInput) {
      targetDate = new Date(dateInput);
      if (isNaN(targetDate.getTime())) {
        await sendFollowUp(app_id, interaction_token, {
          content: "❌ **Invalid date format**\n\nPlease use YYYY-MM-DD format."
        });
        return;
      }
    }

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    const dateKey = targetDate.toISOString().split("T")[0];

    logger.info(`Processing team summary for project ${projectFilter} on ${dateKey}`);

    // Get project info
    const projects = await fetchProjects();
    const selectedProject = projects.find(
      (p) =>
        p.name.toLowerCase() === projectFilter.toLowerCase() ||
        p.identifier.toLowerCase() === projectFilter.toLowerCase()
    );

    if (!selectedProject) {
      await sendFollowUp(app_id, interaction_token, {
        content: `❌ **Project not found**: ${projectFilter}`
      });
      return;
    }

    const projectId = selectedProject.id;
    const projectName = selectedProject.name;

    // Get project members
    const members = await getProjectMembers(projectId);
    logger.info(`Found ${members.length} members in project ${projectName}`);
    logger.info(`Member list: ${members.map(m => m.display_name || m.user?.display_name || m.email).join(", ")}`);

    // Get cycle info
    const cycles = await getCyclesWithCache(projectId);
    logger.info(`Found ${cycles.length} total cycles for project`);

    const [year, month, day] = dateKey.split('-').map(Number);
    const queryDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

    // Find active cycles (both current and cycles that contain the date)
    const relevantCycles = cycles.filter((c) => {
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

    let cycleInfo = "No active cycles";
    if (relevantCycles.length > 0) {
      cycleInfo = relevantCycles
        .map((c) => {
          const totalIssues = c.totalIssues || 0;
          const completedIssues = c.completedIssues || 0;
          const percentage = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
          return `${c.name} -> ${percentage}% completed`;
        })
        .join("\n");
    }

    logger.info(`Cycle info: ${cycleInfo}`);

    // Clear caches for fresh data
    clearActivityCaches();

    // Get activities for each team member
    const teamMemberData = [];
    logger.info(`Processing ${members.length} team members for activities on ${dateKey}`);

    // Members to ignore in team summaries
    const ignoredMembers = ['suhas', 'abhinav'];

    for (const member of members) {
      const userData = member.member || member.user || member;
      const memberName =
        member.display_name ||
        userData.display_name ||
        userData.first_name ||
        userData.email ||
        "Unknown";

      if (memberName === "Unknown") {
        logger.warn(`Skipping member with Unknown name`);
        continue;
      }

      // Skip ignored members
      if (ignoredMembers.some(ignored => memberName.toLowerCase().includes(ignored))) {
        logger.info(`Skipping ignored member: ${memberName}`);
        continue;
      }

      logger.info(`Processing member: ${memberName}`);

      try {
        const personActivities = await getTeamActivities(
          startOfDay,
          endOfDay,
          projectFilter,
          memberName
        );

        // Continue processing even if no activities for this date
        logger.info(`Member ${memberName}: ${personActivities.length} activities on ${dateKey}`);

        const completed = [];
        const inProgress = [];
        const workItemStates = new Map();
        const comments = []; // Store comments for progress tracking

        for (const activity of personActivities) {
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

        // Log comment count for debugging
        if (comments.length > 0) {
          logger.info(`Member ${memberName}: Found ${comments.length} comments`);
        }

        // Add all members to the summary, even if they have no activity
        teamMemberData.push({ name: memberName, completed, inProgress, comments });
        logger.info(`Added member ${memberName} to summary: ${completed.length} done, ${inProgress.length} in progress, ${comments.length} comments`);
      } catch (error) {
        logger.warn(`Error fetching activities for ${memberName}: ${error.message}`);
      }
    }

    logger.info(`Team member processing complete: ${teamMemberData.length} members with data`);

    if (teamMemberData.length === 0) {
      await sendFollowUp(app_id, interaction_token, {
        embeds: [{
          color: 0x99aab5,
          title: `📊 Team Daily Summary for ${projectName} (${dateKey})`,
          description: "No team activity found for this period.",
          footer: { text: "0 team members with activity" }
        }]
      });
      return;
    }

    // Format and send summary using AI
    const formattedTeamData = teamMemberData
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

**Tasks/SubTasks Done:**
• TASK-ID: Task Name

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)

**Comments/Updates:**
• TASK-ID: Brief comment summary

[Continue for all team members...]

---

FORMATTING RULES:
- Project name should be in bold
- Cycle info on its own line with arrow and percentage
- Each team member name should be in bold
- Use bullet points (•) for task lists
- Include task ID and name for each item
- For in-progress items, include the state in parentheses
- For comments, include the task ID and a brief summary of the update
- If a member has no completed tasks, show "None" under Done
- If a member has no in-progress tasks, show "None" under In Progress
- If a member has no comments, show "None" under Comments/Updates
- Separate team members with blank lines
- Include ALL team members provided, even those with no activity

If no team members have activities, respond with: "No team activity found for this period."

CRITICAL: You MUST include ALL team members in the output, even those with no completed, in-progress, or comment activities.`;
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

    const summary = result.text;

    // Split into chunks if needed (Discord limit 4096)
    const MAX_LENGTH = 4096;
    const embeds = [];
    let remaining = summary;

    while (remaining.length > 0) {
      let chunk = remaining.substring(0, MAX_LENGTH);
      if (remaining.length > MAX_LENGTH) {
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline > MAX_LENGTH * 0.8) {
          chunk = remaining.substring(0, lastNewline);
        }
      }

      embeds.push({
        color: 0x5865f2,
        ...(embeds.length === 0 ? { title: `📊 Team Daily Summary for ${projectName} (${dateKey})` } : {}),
        description: chunk,
        footer: { text: `${teamMemberData.length} team members • Page ${embeds.length + 1}` }
      });

      remaining = remaining.substring(chunk.length);
    }

    await sendFollowUp(app_id, interaction_token, { embeds });
    logger.info('Team summary sent successfully');

  } catch (error) {
    logger.error(`Error generating team summary: ${error.message}`, error);
    await sendFollowUp(app_id, interaction_token, {
      content: `❌ **Error generating summary**\n\n${error.message}`
    });
  }
}

/**
 * Interaction Endpoint
 */
router.post('/', async (request, env, ctx) => {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.arrayBuffer();

  const isValidRequest = verifyKey(
    new Uint8Array(body),
    signature,
    timestamp,
    env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    logger.warn('Invalid request signature');
    return new Response('Bad request signature.', { status: 401 });
  }

  const interaction = JSON.parse(new TextDecoder().decode(body));

  // Initialize Services for every request
  initPlaneService({
    PLANE_API_KEY: env.PLANE_API_KEY,
    PLANE_BASE_URL: env.PLANE_BASE_URL || 'https://plane.superalign.ai/api/v1',
    WORKSPACE_SLUG: env.WORKSPACE_SLUG,
  });

  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name } = interaction.data;

    if (name === 'person_daily_summary') {
      ctx.waitUntil(processPersonDailySummary(interaction, env));
      return Response.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    }

    if (name === 'team_daily_summary') {
      ctx.waitUntil(processTeamDailySummary(interaction, env));
      return Response.json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });
    }
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const { name, options } = interaction.data;
    const focusedOption = options?.find(o => o.focused);

    if (!focusedOption) {
      return Response.json({ type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } });
    }

    if (name === 'person_daily_summary' && focusedOption.name === 'person') {
      try {
        logger.debug(`Autocomplete for person_daily_summary person: "${focusedOption.value}"`);
        const people = await getPeople();
        logger.debug(`Fetched ${people.length} people for person_daily_summary autocomplete`);

        if (!people || people.length === 0) {
          logger.warn("No people available for person_daily_summary autocomplete");
          return Response.json({
            type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [{ name: "No people found", value: "none" }] }
          });
        }

        const focusedValue = focusedOption.value?.toLowerCase() || '';

        const filtered = people
          .filter(p => {
            if (!p || !p.name) return false;
            if (!focusedValue) return true; // Show all if no input
            return p.name.toLowerCase().includes(focusedValue);
          })
          .slice(0, 25)
          .map(p => ({ name: p.name, value: p.name }));

        logger.debug(`Returning ${filtered.length} filtered people for person_daily_summary`);

        if (filtered.length === 0) {
          return Response.json({
            type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [{ name: `No people match "${focusedValue}"`, value: "no_match" }] }
          });
        }

        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: filtered }
        });
      } catch (error) {
        logger.error("Error in person_daily_summary person autocomplete:", error);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [{ name: "Error loading people", value: "error" }] }
        });
      }
    }

    if (name === 'person_daily_summary' && focusedOption.name === 'team') {
      try {
        logger.debug(`Autocomplete for person_daily_summary team: "${focusedOption.value}"`);
        const projects = await fetchProjects();
        logger.debug(`Fetched ${projects.length} projects for person_daily_summary autocomplete`);

        if (!projects || projects.length === 0) {
          logger.warn("No projects available for person_daily_summary autocomplete");
          return Response.json({
            type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [{ name: "No projects found", value: "none" }] }
          });
        }

        const focusedValue = focusedOption.value?.toLowerCase() || '';

        const filtered = projects
          .filter(p => {
            if (!p) return false;
            if (!focusedValue) return true; // Show all if no input

            const nameMatch = p.name?.toLowerCase().includes(focusedValue);
            const identifierMatch = p.identifier?.toLowerCase().includes(focusedValue);
            return nameMatch || identifierMatch;
          })
          .slice(0, 25)
          .map(p => ({
            name: `${p.name || "Unknown"} (${p.identifier || "no-id"})`.substring(0, 100),
            value: p.identifier || p.id
          }));

        logger.debug(`Returning ${filtered.length} filtered projects for person_daily_summary`);

        if (filtered.length === 0) {
          return Response.json({
            type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [{ name: `No projects match "${focusedValue}"`, value: "no_match" }] }
          });
        }

        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: filtered }
        });
      } catch (error) {
        logger.error("Error in person_daily_summary team autocomplete:", error);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [{ name: "Error loading projects", value: "error" }] }
        });
      }
    }

    // Team daily summary - project autocomplete
    if (name === 'team_daily_summary' && focusedOption.name === 'project') {
      try {
        logger.info(`Autocomplete for team_daily_summary project: "${focusedOption.value}"`);
        const projects = await fetchProjects();
        logger.info(`Fetched ${projects.length} projects for autocomplete`);

        const filtered = projects
          .filter(p =>
            p.name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
            p.identifier.toLowerCase().includes(focusedOption.value.toLowerCase())
          )
          .slice(0, 25)
          .map(p => ({ name: `${p.name} (${p.identifier})`, value: p.identifier }));

        logger.info(`Returning ${filtered.length} filtered projects`);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: filtered }
        });
      } catch (error) {
        logger.error(`Error in team_daily_summary autocomplete: ${error.message}`);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [] }
        });
      }
    }
  }

  return new Response('Not found', { status: 404 });
});

/**
 * Send a message to a Discord channel using Bot Token
 */
async function sendMessageToChannel(channelId, discordToken, payload) {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${discordToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to send channel message: ${response.status} ${errorText}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error sending channel message: ${error.message}`);
    return false;
  }
}

/**
 * Parse AI text into Embed sections for scheduled summary
 */
function parseScheduledSummaryToEmbed(personName, date, text, workspaceSlug) {
  const sections = text.split(/###\s+/);
  const fields = [];
  let description = `Daily Summary for **${personName}** - **${date}**\n`;

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const lines = section.split('\n');
    const title = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();

    if (title && content) {
      fields.push({
        name: title,
        value: content.length > 1024 ? content.substring(0, 1021) + '...' : content,
        inline: false
      });
    }
  }

  if (fields.length === 0) {
    description = text;
  }

  return {
    embeds: [{
      title: `📊 Daily Summary: ${personName} (${date})`,
      description: description,
      color: 0x3498db,
      fields: fields,
      footer: {
        text: `Team: ${workspaceSlug || 'Plane'} • Scheduled Summary`
      },
      timestamp: new Date().toISOString()
    }]
  };
}

/**
 * Scheduled handler for cron trigger - runs at 9AM IST daily
 */
async function handleScheduled(event, env, ctx) {
  logger.info('Cron job triggered: Daily summary at 9AM IST');

  const channelId = env.DAILY_SUMMARY_CHANNEL_ID;
  const discordToken = env.DISCORD_TOKEN;

  if (!channelId) {
    logger.error('DAILY_SUMMARY_CHANNEL_ID is not configured');
    return;
  }

  if (!discordToken) {
    logger.error('DISCORD_TOKEN is not configured');
    return;
  }

  // Initialize Plane service
  initPlaneService({
    PLANE_API_KEY: env.PLANE_API_KEY,
    PLANE_BASE_URL: env.PLANE_BASE_URL || 'https://plane.superalign.ai/api/v1',
    WORKSPACE_SLUG: env.WORKSPACE_SLUG,
  });

  try {
    // Get today's date in IST (UTC+5:30)
    const now = new Date();
    // Convert to IST by adding 5 hours 30 minutes
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    const today = istDate.toISOString().split('T')[0];

    // Get all workspace members
    const members = await getWorkspaceMembers();

    if (!members || members.length === 0) {
      logger.warn('No workspace members found for scheduled summary');
      await sendMessageToChannel(channelId, discordToken, {
        content: `⚠️ No workspace members found for daily summary on ${today}`
      });
      return;
    }

    // Send a header message
    await sendMessageToChannel(channelId, discordToken, {
      content: `📅 **Daily Team Summary - ${today}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    });

    let summariesSent = 0;
    let noActivityCount = 0;

    // Process each member SEQUENTIALLY to avoid data mixing
    // Each person is fully processed before moving to the next
    for (const member of members) {
      const userData = member.member || member.user || member;
      const displayName = member.display_name || userData.display_name || userData.first_name || userData.email;

      if (!displayName || displayName === "Unknown User") {
        continue;
      }

      try {
        // Clear activity caches before each person to ensure fresh, isolated data
        clearActivityCaches();

        logger.info(`Processing scheduled summary for: ${displayName}`);

        // Step 1: Fetch and generate summary for this person
        const summary = await getPersonDailySummary({
          personName: displayName,
          date: today,
          projectFilter: null,
          workspaceSlug: env.WORKSPACE_SLUG
        });

        // Step 2: Check if there's any activity
        if (!summary.projects || summary.projects.length === 0) {
          noActivityCount++;
          logger.info(`No activity for ${displayName}, skipping`);
          continue;
        }

        // Step 3: Generate the text summary
        const text = await generatePersonDailySummaryText(summary, env);

        // Step 4: Create embed payload
        const embedPayload = parseScheduledSummaryToEmbed(displayName, today, text, env.WORKSPACE_SLUG);

        // Step 5: Send to Discord and wait for confirmation
        const sent = await sendMessageToChannel(channelId, discordToken, embedPayload);

        if (sent) {
          summariesSent++;
          logger.info(`Successfully sent scheduled summary for ${displayName}`);
        } else {
          logger.warn(`Failed to send summary for ${displayName}`);
        }

        // Step 6: Wait before processing next person to avoid rate limiting and ensure isolation
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        logger.error(`Error generating scheduled summary for ${displayName}: ${error.message}`);
        // Continue to next person even if one fails
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Clear caches one final time after all processing
    clearActivityCaches();

    // Send a footer message with stats
    await sendMessageToChannel(channelId, discordToken, {
      content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Sent **${summariesSent}** summaries | ⏸️ **${noActivityCount}** members with no activity`
    });

    logger.info(`Scheduled summary complete: ${summariesSent} summaries sent, ${noActivityCount} with no activity`);

  } catch (error) {
    logger.error(`Error in scheduled summary: ${error.message}`, error);
    await sendMessageToChannel(channelId, discordToken, {
      content: `❌ **Error generating scheduled daily summaries**\n\n${error.message}`
    });
  }
}

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
  scheduled: handleScheduled,
};