import { Router } from 'itty-router';
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';
import { getPeople, getPersonDailySummary, generatePersonDailySummaryText } from './services/personDailySummary.js';
import { initPlaneService, fetchProjects } from './services/planeApiDirect.js';
import logger from './utils/logger.js';

const router = Router();

/**
 * PING Handshake
 */
router.get('/', () => new Response('Plane Discord Bot is running!'));

/**
 * Interaction Endpoint
 */
router.post('/', async (request, env) => {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');

  // Clone the request if we need to read the body multiple times, 
  // but arrayBuffer() is fine here since we decode it ourselves.
  const body = await request.arrayBuffer();

  // 1. Verify Request
  // Use env.DISCORD_PUBLIC_KEY which should be the hex string from Discord Dev Portal
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
  logger.info(`Interaction received: Type ${interaction.type}`, { id: interaction.id });

  // 2. Initialize Services with Environment Secrets
  initPlaneService({
    PLANE_API_KEY: env.PLANE_API_KEY,
    PLANE_BASE_URL: env.PLANE_BASE_URL || 'https://plane.superalign.ai/api/v1',
    WORKSPACE_SLUG: env.WORKSPACE_SLUG,
  });

  // 3. Handle PING
  if (interaction.type === InteractionType.PING) {
    logger.info('Responding to PING');
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // 4. Handle Commands
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = interaction.data;
    logger.info(`Handling command: ${name}`);

    if (name === 'person_daily_summary') {
      const personName = options?.find(o => o.name === 'person')?.value;
      const date = options?.find(o => o.name === 'date')?.value || new Date().toISOString().split('T')[0];
      const projectFilter = options?.find(o => o.name === 'team')?.value;

      try {
        const summary = await getPersonDailySummary({
          personName,
          date,
          projectFilter,
          workspaceSlug: env.WORKSPACE_SLUG
        });
        const text = await generatePersonDailySummaryText(summary, {
          GEMINI_MODEL: env.GEMINI_MODEL,
          GEMINI_TEMPERATURE: env.GEMINI_TEMPERATURE,
          GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY
        });

        return Response.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: text }
        });
      } catch (error) {
        logger.error(`Error generating summary: ${error.message}`, error);
        return Response.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `Error generating summary: ${error.message}`, flags: 64 }
        });
      }
    }
  }

  // 5. Handle Autocomplete
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const { name, options } = interaction.data;
    const focusedOption = options?.find(o => o.focused);

    if (!focusedOption) return Response.json({ type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } });

    if (name === 'person_daily_summary' && focusedOption.name === 'person') {
      const people = await getPeople();
      const filtered = people
        .filter(p => p.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
        .slice(0, 25)
        .map(p => ({ name: p.name, value: p.name }));

      return Response.json({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: filtered }
      });
    }

    if (name === 'person_daily_summary' && focusedOption.name === 'team') {
      const projects = await fetchProjects();
      const filtered = projects
        .filter(p =>
          p.name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
          p.identifier.toLowerCase().includes(focusedOption.value.toLowerCase())
        )
        .slice(0, 25)
        .map(p => ({ name: `${p.name} (${p.identifier})`, value: p.identifier }));

      return Response.json({
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: filtered }
      });
    }
  }

  return new Response('Unknown interaction type', { status: 400 });
});

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
};
