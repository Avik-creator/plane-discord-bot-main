import { Router } from 'itty-router';
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';
import { getPeople, getPersonDailySummary, generatePersonDailySummaryText } from './services/personDailySummary.js';
import { initPlaneService, fetchProjects, getWorkspaceMembers, clearActivityCaches } from './services/planeApiDirect.js';
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
  logger.info('Plane service initialized for request');

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
      try {
        logger.info('Fetching people for person autocomplete');
        const people = await getPeople();
        logger.info(`Found ${people.length} people for autocomplete`);

        const filtered = people
          .filter(p => p && p.name && p.name.toLowerCase().includes(focusedOption.value.toLowerCase()))
          .slice(0, 25)
          .map(p => ({ name: p.name, value: p.name }));

        logger.info(`Returning ${filtered.length} filtered people`);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: filtered }
        });
      } catch (error) {
        logger.error('Error fetching people for person autocomplete:', error);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: [] }
        });
      }
    }

    if (name === 'person_daily_summary' && focusedOption.name === 'team') {
      try {
        logger.info('Fetching projects for team autocomplete');
        const projects = await fetchProjects();
        logger.info(`Found ${projects.length} projects for autocomplete`);

        const filtered = projects
          .filter(p => {
            const name = p.name || p.identifier || 'Unknown';
            const identifier = p.identifier || p.name || p.id || 'unknown';
            return name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
                   identifier.toLowerCase().includes(focusedOption.value.toLowerCase());
          })
          .slice(0, 25)
          .map(p => {
            const name = p.name || p.identifier || 'Unknown';
            const identifier = p.identifier || p.name || p.id || 'unknown';
            return { name: `${name} (${identifier})`, value: identifier };
          });

        logger.info(`Returning ${filtered.length} filtered projects`);
        return Response.json({
          type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
          data: { choices: filtered }
        });
      } catch (error) {
        logger.error('Error fetching projects for team autocomplete:', error);
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