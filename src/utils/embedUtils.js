/**
 * Parse AI text into Embed sections for daily summaries
 * @param {string} personName - Name of the person
 * @param {string} date - Date string
 * @param {string} text - AI-generated summary text
 * @param {string} workspaceSlug - Workspace identifier
 * @returns {Object} Discord embed payload
 */
export function parseSummaryToEmbed(personName, date, text, workspaceSlug) {
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
 * Parse AI text into Embed sections for scheduled summaries
 * @param {string} personName - Name of the person
 * @param {string} date - Date string
 * @param {string} text - AI-generated summary text
 * @param {string} workspaceSlug - Workspace identifier
 * @returns {Object} Discord embed payload
 */
export function parseScheduledSummaryToEmbed(personName, date, text, workspaceSlug) {
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
 * Create team summary embeds from formatted text
 * @param {string} projectName - Name of the project
 * @param {string} dateKey - Date key
 * @param {string} summary - Formatted summary text
 * @param {number} memberCount - Number of team members
 * @param {number} pageNum - Current page number
 * @returns {Object} Discord embed payload
 */
export function createTeamSummaryEmbed(projectName, dateKey, summary, memberCount, pageNum = 0) {
  // Split into chunks if needed (Discord limit 4096)
  const MAX_LENGTH = 4096;
  const embeds = [];
  let remaining = summary;

  while (remaining.length > 0) {
    let chunk = remaining.substring(0, MAX_LENGTH);
    if (remaining.length > MAX_LENGTH) {
      const lastNewline = chunk.lastIndexOf("\n");
      if (lastNewline > MAX_LENGTH * 0.8) {
        chunk = remaining.substring(0, lastNewline);
      }
    }

    embeds.push({
      color: 0x5865f2,
      ...(embeds.length === 0 ? { title: `📊 Team Daily Summary for ${projectName} (${dateKey})` } : {}),
      description: chunk,
      footer: { text: `${memberCount} team members • Page ${embeds.length + 1}` }
    });

    remaining = remaining.substring(chunk.length);
  }

  return { embeds };
}
