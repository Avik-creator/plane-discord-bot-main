import logger from '../utils/logger.js';

/**
 * Send a follow-up message via Discord webhooks
 * @param {string} applicationId - Discord application ID
 * @param {string} interactionToken - Interaction token
 * @param {Object} payload - Message payload
 */
export async function sendFollowUp(applicationId, interactionToken, payload) {
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
 * Send a message to a Discord channel using Bot Token
 * @param {string} channelId - Discord channel ID
 * @param {string} discordToken - Discord bot token
 * @param {Object} payload - Message payload
 * @returns {boolean} Success status
 */
export async function sendMessageToChannel(channelId, discordToken, payload) {
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
 * Create an error embed for Discord
 * @param {string} title - Error title
 * @param {string} message - Error message
 * @param {boolean} ephemeral - Whether to make it ephemeral
 * @returns {Object} Discord response payload
 */
export function createErrorResponse(title, message, ephemeral = true) {
  return {
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      content: `❌ **${title}**\n\n${message}`,
      flags: ephemeral ? 64 : 0 // Ephemeral flag
    }
  };
}

/**
 * Create a deferred response for Discord
 * @returns {Object} Discord deferred response payload
 */
export function createDeferredResponse() {
  return {
    type: 5 // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  };
}
