import { InteractionType, InteractionResponseType } from 'discord-interactions';
import { initPlaneService } from '../services/planeApiDirect.js';
import { handlePersonDailySummary } from './personSummaryHandler.js';
import { handleTeamDailySummary } from './teamSummaryHandler.js';
import { handleAutocomplete } from './autocompleteHandler.js';
import { createDeferredResponse } from '../services/discordService.js';
import logger from '../utils/logger.js';

/**
 * Handle Discord interactions
 * @param {Request} request - HTTP request
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Context object
 * @returns {Response} HTTP response
 */
export async function handleInteraction(request, env, ctx) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  const body = await request.arrayBuffer();

  const { verifyKey } = await import('discord-interactions');
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

  // Handle PING
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // Handle Application Commands
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return await handleApplicationCommand(interaction, env, ctx);
  }

  // Handle Application Command Autocomplete
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return await handleApplicationCommandAutocomplete(interaction, env);
  }

  return new Response('Not found', { status: 404 });
}

/**
 * Handle application commands
 * @param {Object} interaction - Discord interaction
 * @param {Object} env - Environment variables
 * @param {Object} ctx - Context object
 * @returns {Response} HTTP response
 */
async function handleApplicationCommand(interaction, env, ctx) {
  const { name } = interaction.data;

  if (name === 'person_daily_summary') {
    ctx.waitUntil(handlePersonDailySummary(interaction, env));
    return Response.json(createDeferredResponse());
  }

  if (name === 'team_daily_summary') {
    ctx.waitUntil(handleTeamDailySummary(interaction, env));
    return Response.json(createDeferredResponse());
  }

  return new Response('Unknown command', { status: 400 });
}

/**
 * Handle application command autocomplete
 * @param {Object} interaction - Discord interaction
 * @param {Object} env - Environment variables
 * @returns {Response} HTTP response
 */
async function handleApplicationCommandAutocomplete(interaction, env) {
  const response = await handleAutocomplete(interaction);
  return Response.json(response);
}
