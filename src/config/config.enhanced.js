import "dotenv/config";

const requiredEnvVars = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "PLANE_API_KEY",
  "PLANE_BASE_URL",
  "WORKSPACE_SLUG",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];

const optionalEnvVars = {
  LOG_LEVEL: "info",
  ENABLE_FILE_LOGS: "false",
  GEMINI_MODEL: "gemini-2.1-flash",
  GEMINI_TEMPERATURE: "0.3",
};

// Validate required environment variables (only if not in Worker)
const isWorker = typeof WebSocketPair !== 'undefined' || (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers');

if (!isWorker) {
  const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);
  if (missingVars.length > 0) {
    console.error(
      `❌ Missing required environment variables: ${missingVars.join(", ")}`
    );
    // process.exit(1); 
  }
}

export default {
  // Discord
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,

  // Plane API
  PLANE_API_KEY: process.env.PLANE_API_KEY,
  PLANE_BASE_URL:
    process.env.PLANE_BASE_URL || "https://plane.superalign.ai/api/v1",
  WORKSPACE_SLUG: process.env.WORKSPACE_SLUG,

  // Gemini AI
  GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || optionalEnvVars.GEMINI_MODEL,
  GEMINI_TEMPERATURE: parseFloat(
    process.env.GEMINI_TEMPERATURE || optionalEnvVars.GEMINI_TEMPERATURE
  ),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || optionalEnvVars.LOG_LEVEL,
  ENABLE_FILE_LOGS:
    process.env.ENABLE_FILE_LOGS || optionalEnvVars.ENABLE_FILE_LOGS,
};
