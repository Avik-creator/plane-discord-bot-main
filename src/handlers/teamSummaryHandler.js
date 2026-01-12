import { fetchProjects } from '../services/planeApiDirect.js';
import {
  processTeamActivities,
  formatTeamDataForAI,
  generateTeamSummary
} from '../services/teamSummaryService.js';
import { sendFollowUp, createErrorResponse } from '../services/discordService.js';
import { createTeamSummaryEmbed } from '../utils/embedUtils.js';
import logger from '../utils/logger.js';

/**
 * Handle the team_daily_summary command
 * @param {Object} interaction - Discord interaction object
 * @param {Object} env - Environment variables
 */
export async function handleTeamDailySummary(interaction, env) {
  const { application_id, token } = interaction;
  const app_id = application_id || interaction.application_id;
  const interaction_token = token || interaction.token;

  const interactionData = interaction.data || {};
  const commandOptions = interactionData.options || [];

  const projectFilter = commandOptions.find(o => o.name === 'project')?.value;
  const dateInput = commandOptions.find(o => o.name === 'date')?.value;

  // Validate required project parameter
  if (!projectFilter || typeof projectFilter !== 'string' || projectFilter.trim() === '') {
    logger.warn('Project parameter is required for team_daily_summary command');
    return createErrorResponse(
      'Error',
      'Please specify a project. Use the autocomplete dropdown to select from available projects.'
    );
  }

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

    // Get project info (project is now required)
    const projects = await fetchProjects();
    const selectedProject = projects.find(
      (p) =>
        p.name?.toLowerCase() === projectFilter.toLowerCase() ||
        p.identifier?.toLowerCase() === projectFilter.toLowerCase() ||
        p.id === projectFilter
    );

    if (!selectedProject) {
      await sendFollowUp(app_id, interaction_token, {
        content: `❌ **Project not found**: \`${projectFilter}\`\n\nPlease use the autocomplete dropdown to select a valid project.`
      });
      return;
    }

    const projectId = selectedProject.id;
    const projectName = selectedProject.name;

    // Process team activities using the OPTIMIZED service
    // The service now handles session management and cache clearing internally
    const { teamMemberData, cycleInfo } = await processTeamActivities(
      projectId,
      projectName,
      projectFilter,
      startOfDay,
      endOfDay,
      dateKey
    );

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
    logger.info(`Formatted team data length: ${formatTeamDataForAI(teamMemberData).length} chars`);
    const formattedTeamData = formatTeamDataForAI(teamMemberData);
    logger.info('Starting AI summary generation...');
    const summary = await generateTeamSummary(formattedTeamData, projectName, dateKey, cycleInfo, env);
    logger.info(`AI summary generated, length: ${summary.length} chars`);

    // Create and send embeds
    logger.info('Sending embed to Discord...');
    const embedPayload = createTeamSummaryEmbed(projectName, dateKey, summary, teamMemberData.length);
    await sendFollowUp(app_id, interaction_token, embedPayload);
    logger.info('Team summary sent successfully');

  } catch (error) {
    logger.error(`Error generating team summary: ${error.message}`, error);
    await sendFollowUp(app_id, interaction_token, {
      content: `❌ **Error generating summary**\n\n${error.message}`
    });
  }
}
