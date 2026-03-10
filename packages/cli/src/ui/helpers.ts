/**
 * Parse human-readable time strings into ISO date strings.
 * Supports: "30s", "5m", "5 min", "2h", "3d", "1w"
 */
export function parseSince(since: string): string {
  const now = Date.now();
  const cleaned = since.trim().toLowerCase();

  const match = cleaned.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/);
  if (!match) {
    // Try to parse as ISO date directly
    const d = new Date(since);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
    throw new Error(`Cannot parse time string: "${since}". Use formats like "30s", "5m", "2h", "3d", "1w".`);
  }

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  let ms: number;
  if (unit.startsWith("s")) {
    ms = amount * 1000;
  } else if (unit.startsWith("m") && !unit.startsWith("mo")) {
    ms = amount * 60 * 1000;
  } else if (unit.startsWith("h")) {
    ms = amount * 60 * 60 * 1000;
  } else if (unit.startsWith("d")) {
    ms = amount * 24 * 60 * 60 * 1000;
  } else if (unit.startsWith("w")) {
    ms = amount * 7 * 24 * 60 * 60 * 1000;
  } else {
    ms = amount * 60 * 1000; // default to minutes
  }

  // Output in SQLite datetime format to match backend storage
  return new Date(now - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Truncate a string with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

/**
 * Convert an ISO date string to a relative time string like "2m ago".
 */
export function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diff = now - then;

  if (isNaN(then)) return isoDate;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
