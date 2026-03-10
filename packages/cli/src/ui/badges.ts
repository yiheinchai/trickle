import chalk from "chalk";
import { relativeTime } from "./helpers";

/**
 * Colored badge for environment names.
 */
export function envBadge(env: string): string {
  const lower = env.toLowerCase();
  if (lower === "prod" || lower === "production") {
    return chalk.bgRed.white.bold(` ${env} `);
  }
  if (lower === "staging" || lower === "stage") {
    return chalk.bgYellow.black.bold(` ${env} `);
  }
  if (lower === "local" || lower === "dev" || lower === "development") {
    return chalk.bgGreen.black.bold(` ${env} `);
  }
  if (lower === "test" || lower === "ci") {
    return chalk.bgCyan.black.bold(` ${env} `);
  }
  return chalk.bgGray.white.bold(` ${env} `);
}

/**
 * Colored badge for language.
 */
export function langBadge(lang: string): string {
  const lower = lang.toLowerCase();
  if (lower === "js" || lower === "javascript" || lower === "typescript" || lower === "ts") {
    return chalk.bgYellow.black(` ${lang} `);
  }
  if (lower === "python" || lower === "py") {
    return chalk.bgBlue.white(` ${lang} `);
  }
  if (lower === "go" || lower === "golang") {
    return chalk.bgCyan.black(` ${lang} `);
  }
  return chalk.bgGray.white(` ${lang} `);
}

/**
 * Colored badge for error type.
 */
export function errorTypeBadge(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("type")) {
    return chalk.bgMagenta.white.bold(` ${type} `);
  }
  if (lower.includes("reference") || lower.includes("undefined")) {
    return chalk.bgRed.white.bold(` ${type} `);
  }
  if (lower.includes("syntax")) {
    return chalk.bgYellow.black.bold(` ${type} `);
  }
  if (lower.includes("range") || lower.includes("overflow")) {
    return chalk.bgCyan.black.bold(` ${type} `);
  }
  return chalk.bgRed.white.bold(` ${type} `);
}

/**
 * Format a timestamp as a relative time badge.
 */
export function timeBadge(timestamp: string): string {
  return chalk.gray(relativeTime(timestamp));
}
