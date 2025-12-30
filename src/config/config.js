require("dotenv").config();

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  PLANE_API_KEY: process.env.PLANE_API_KEY,
  WORKSPACE_SLUG: process.env.WORKSPACE_SLUG,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  ENABLE_FILE_LOGS: process.env.ENABLE_FILE_LOGS || "false",
};
