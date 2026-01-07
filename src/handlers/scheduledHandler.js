import { fetchProjects, initPlaneService, clearActivityCaches, startProjectSession } from '../services/planeApiDirect.js';
import {
  processTeamActivities,
  formatTeamDataForAI,
  generateTeamSummary
} from '../services/teamSummaryService.js';
import { sendMessageToChannel } from '../services/discordService.js';
import { createTeamSummaryEmbed } from '../utils/embedUtils.js';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import logger from '../utils/logger.js';

/**
 * Handle scheduled team summary job
 * @param {Object} event - Scheduled event
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Context object
 */
export async function handleScheduled(event, env, ctx) {
  logger.info('Cron job triggered: Daily team summary at 8:00 PM IST (2:30 PM UTC)');

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
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    const today = istDate.toISOString().split('T')[0];

    // Get all projects
    const projects = await fetchProjects();

    if (!projects || projects.length === 0) {
      logger.warn('No projects found for scheduled team summary');
      await sendMessageToChannel(channelId, discordToken, {
        content: `⚠️ No projects found for daily team summary on ${today}`
      });
      return;
    }

    // Send a header message
    await sendMessageToChannel(channelId, discordToken, {
      content: `📅 **Daily Team Summary - ${today}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    });

    let summariesSent = 0;
    let noActivityCount = 0;

    // Initialize AI model once
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });

    // Process each project SEQUENTIALLY to avoid data mixing
    for (const project of projects) {
      try {
        const projectId = project.id;
        const projectName = project.name;
        const projectIdentifier = project.identifier;

        logger.info(`Processing scheduled team summary for project: ${projectName}`);

        // Start a new caching session for this project
        // This ensures fresh data is fetched once, then cached for all subsequent requests within this project
        startProjectSession(projectId);

        // Clear old activity caches before starting new session
        clearActivityCaches();

        // Parse date for activity filtering
        const startOfDay = new Date(istDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(istDate);
        endOfDay.setHours(23, 59, 59, 999);

        // Process team activities using the shared service
        const { teamMemberData, cycleInfo } = await processTeamActivities(
          projectId,
          projectName,
          projectIdentifier,
          startOfDay,
          endOfDay,
          today
        );

        // Skip if no activity
        if (teamMemberData.length === 0) {
          noActivityCount++;
          logger.info(`No activity in project ${projectName}, skipping`);
          continue;
        }

        // Format data for AI (same as team_daily_summary)
        const formattedTeamData = formatTeamDataForAI(teamMemberData);

        // Use AI to format summary
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

**Tasks/SubTasks Todo:**
• TASK-ID: Task Name (State)
[or "None" if no todo items]

**Comments/Updates:**
• TASK-ID: Brief comment summary
[or "None" if no comments]

**TEAM_MEMBER_B**

**Tasks/SubTasks Done:**
• TASK-ID: Task Name

**Tasks/SubTasks in Progress:**
• TASK-ID: Task Name (State)

**Tasks/SubTasks Todo:**
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
- For todo items, include the state in parentheses
- For comments, include the task ID and a brief summary of the update
- If a member has no completed tasks, show "None" under Done
- If a member has no in-progress tasks, show "None" under In Progress
- If a member has no todo items, show "None" under Todo
- If a member has no comments, show "None" under Comments/Updates
- Separate team members with blank lines
- Include ALL team members provided, even those with no activity

If no team members have activities, respond with: "No team activity found for this period."

CRITICAL: You MUST include ALL team members in the output, even those with no completed, in-progress, or comment activities.`;

        const userPrompt = `Format this team daily summary for ${today} using the exact format specified. Include comments as they show progress on tasks even when there are no formal state changes.
PROJECT: ${projectName}
CYCLE INFO: ${cycleInfo}

TEAM MEMBERS DATA:
${formattedTeamData}`;

        const result = await generateText({
          model: google(env.GEMINI_MODEL || "gemini-1.5-flash"),
          system: systemPrompt,
          prompt: userPrompt,
          temperature: env.GEMINI_TEMPERATURE || 0.3,
        });

        const summary = result.text;

        // Create and send embeds
        const embedPayload = createTeamSummaryEmbed(projectName, today, summary, teamMemberData.length);

        // Send to Discord
        const sent = await sendMessageToChannel(channelId, discordToken, embedPayload);

        if (sent) {
          summariesSent++;
          logger.info(`Successfully sent scheduled team summary for ${projectName}`);
        }

        // Wait 60 seconds between projects to stay under Plane's 60 req/min rate limit
        // This ensures we never exceed the rate limit even with multiple API calls per project
        logger.info(`Waiting 120 seconds before processing next project...`);
        await new Promise(resolve => setTimeout(resolve, 120000));

      } catch (projectError) {
        logger.error(`Error generating scheduled team summary for project ${project.name}: ${projectError.message}`);
        await new Promise(resolve => setTimeout(resolve, 12000));
      }
    }

    // Clear caches after all processing
    clearActivityCaches();

    // Send footer with stats
    await sendMessageToChannel(channelId, discordToken, {
      content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Sent **${summariesSent}** team summaries | ⏸️ **${noActivityCount}** projects with no activity`
    });

    logger.info(`Scheduled team summary complete: ${summariesSent} summaries sent, ${noActivityCount} with no activity`);

  } catch (error) {
    logger.error(`Error in scheduled team summary: ${error.message}`, error);
    await sendMessageToChannel(channelId, discordToken, {
      content: `❌ **Error generating scheduled daily team summaries**\n\n${error.message}`
    });
  }
}
