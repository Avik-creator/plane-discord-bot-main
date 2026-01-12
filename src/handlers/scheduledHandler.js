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
    // Parse date like the manual team_daily_summary command does
    let targetDate = new Date();

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Get date string for display
    const dateKey = targetDate.toISOString().split('T')[0];

    // Get all projects
    const allProjects = await fetchProjects();

    if (!allProjects || allProjects.length === 0) {
      logger.warn('No projects found for scheduled team summary');
      await sendMessageToChannel(channelId, discordToken, {
        content: `⚠️ No projects found for daily team summary on ${dateKey}`
      });
      return;
    }

    // Filter to only process specific projects: Radar(RADAR), Forga(FORGE), SLM - Radar Agent(SLMRA), HSBC Smart Splunk(HSBCS)
    const allowedProjectIdentifiers = ['RADAR', 'FORGE', 'SLMRA', 'HSBCS'];
    const projects = allProjects.filter(project => allowedProjectIdentifiers.includes(project.identifier));

    logger.info(`Filtered to ${projects.length} out of ${allProjects.length} total projects for scheduled processing`);

    if (projects.length === 0) {
      logger.warn('No allowed projects found for scheduled team summary');
      await sendMessageToChannel(channelId, discordToken, {
        content: `⚠️ No allowed projects found for daily team summary on ${dateKey}`
      });
      return;
    }

    // Send a header message
    await sendMessageToChannel(channelId, discordToken, {
      content: `📅 **Daily Team Summary - ${dateKey}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
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

        // Process team activities using the shared service (same as manual command)
        const { teamMemberData, cycleInfo } = await processTeamActivities(
          projectId,
          projectName,
          projectIdentifier,
          startOfDay,
          endOfDay,
          dateKey
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

---`;
        const userPrompt = `Format this team daily summary for ${dateKey} using the exact format specified. Include comments as they show progress on tasks even when there are no formal state changes.
PROJECT: ${projectName}
CYCLE INFO: ${cycleInfo}

TEAM MEMBERS DATA:
${formattedTeamData}`;
        const result = await generateText({
          model: google(env.GEMINI_MODEL || "gemini-2.5-flash"),
          system: systemPrompt,
          prompt: userPrompt,
          temperature: env.GEMINI_TEMPERATURE || 0.3,
        });

        const summary = result.text;

        if (summariesSent > 0) {
          await sendMessageToChannel(channelId, discordToken, {
            content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 **${projectName}** Summary\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
          });
        }

        // Create and send embeds
        const embedPayload = createTeamSummaryEmbed(projectName, dateKey, summary, teamMemberData.length);

        // Send to Discord
        const sent = await sendMessageToChannel(channelId, discordToken, embedPayload);

        if (sent) {
          summariesSent++;
          logger.info(`Successfully sent scheduled team summary for ${projectName}`);
        }

        // Wait 30 seconds between projects to stay under Plane's 60 req/min rate limit
        // This ensures we never exceed the rate limit even with multiple API calls per project
        logger.info(`Waiting 25 seconds before processing next project...`);
        await new Promise(resolve => setTimeout(resolve, 25000));

      } catch (projectError) {
        logger.error(`Error generating scheduled team summary for project ${project.name}: ${projectError.message}`);
        await new Promise(resolve => setTimeout(resolve, 30000));
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
