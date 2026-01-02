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
  }

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

  return new Response('Not found', { status: 404 });
});

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
};