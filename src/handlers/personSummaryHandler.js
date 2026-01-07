import { getPersonDailySummary, generatePersonDailySummaryText } from '../services/personDailySummary.js';
import { sendFollowUp, createErrorResponse } from '../services/discordService.js';
import { parseSummaryToEmbed } from '../utils/embedUtils.js';
import logger from '../utils/logger.js';

/**
 * Handle the person_daily_summary command
 * @param {Object} interaction - Discord interaction object
 * @param {Object} env - Environment variables
 */
export async function handlePersonDailySummary(interaction, env) {
  const { options, application_id, token } = interaction;
  // itty-router might wrap data differently
  const app_id = application_id || interaction.application_id;
  const interaction_token = token || interaction.token;

  const interactionData = interaction.data || {};
  const commandOptions = interactionData.options || [];

  const personName = commandOptions.find(o => o.name === 'person')?.value;
  const date = commandOptions.find(o => o.name === 'date')?.value || new Date().toISOString().split('T')[0];
  const projectFilter = commandOptions.find(o => o.name === 'team')?.value;

  // Validate required parameters
  if (!personName || typeof personName !== 'string' || personName.trim() === '') {
    logger.warn('Person name is required for person_daily_summary command');
    return createErrorResponse(
      'Error',
      'Please specify a person name. Use the autocomplete dropdown to select from available team members.'
    );
  }

  try {
    // Validate date format if provided
    if (commandOptions.find(o => o.name === 'date')?.value) {
      const dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        logger.warn(`Invalid date provided: ${date}`);
        return createErrorResponse(
          'Invalid date format',
          'Please use YYYY-MM-DD format (e.g., 2025-01-07).'
        );
      }
    }

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
