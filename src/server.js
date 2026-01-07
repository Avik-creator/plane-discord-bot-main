import { Router } from 'itty-router';
import { handleInteraction } from './handlers/interactionHandler.js';
import { handleScheduled } from './handlers/scheduledHandler.js';

// https://plane-discord-bot.abhinav-103.workers.dev

const router = Router();

/**
 * PING Handshake / Health check
 */
router.get('/', () => new Response('Plane Discord Bot is running!'));

/**
 * Discord Interaction Endpoint
 */
router.post('/', handleInteraction);

/**
 * Scheduled handler for cron trigger
 */
async function scheduledHandler(event, env, ctx) {
  await handleScheduled(event, env, ctx);
}

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
  scheduled: scheduledHandler,
};