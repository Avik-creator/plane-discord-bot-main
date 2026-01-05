export const getPriorityColor = (priority) => {
  const colors = {
    urgent: 0xdc2626, // Bright Red
    high: 0xea580c, // Bright Orange
    medium: 0xca8a04, // Golden Yellow
    low: 0x16a34a, // Green
  };
  return colors[priority?.toLowerCase()] || 0x6b7280; // Default gray
};

export const getPriorityEmoji = (priority) => {
  const emojis = {
    urgent: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🟢",
    none: "⚪",
  };
  return emojis[priority?.toLowerCase()] || emojis.none;
};

export const getStateEmoji = (group) => {
  const emojis = {
    backlog: "📋",
    unstarted: "⭕",
    started: "▶️",
    completed: "✅",
    cancelled: "❌",
    duplicate: "🔄",
  };
  return emojis[group?.toLowerCase()] || "❔";
};

export const formatState = (state, group) => {
  if (!state) return "Unknown";
  const emoji = getStateEmoji(group);
  const formattedState =
    state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
  return `${emoji} ${formattedState}`;
};

export const getIssueColor = (issue) => {
  // First try to use state color
  if (issue.state_detail?.color) {
    return parseInt(issue.state_detail.color.replace("#", ""), 16);
  }
  // Fallback to priority color
  return getPriorityColor(issue.priority);
};

export const formatDate = (dateString) => {
  return new Date(dateString).toLocaleString();
};

export const formatDescription = (description) => {
  if (!description) return "";
  const trimmed = description.trim();
  return trimmed ? `>>> ${trimmed}` : "";
};

export const getIssueUrl = (workspaceSlug, projectId, issueId) => {
  return `https://app.plane.so/${workspaceSlug}/projects/${projectId}/issues/${issueId}`;
};

export const formatLabels = (labels) => {
  if (!labels || labels.length === 0) return [];

  return labels.map((label) => {
    const colorInt = label.color
      ? parseInt(label.color.replace("#", ""), 16)
      : 0x6b7280;
    return {
      name: "🏷️",
      value: `\`${label.name}\``,
      inline: true,
      color: colorInt,
    };
  });
};
