import chalk from "chalk";
import { tailEvents, TailEvent } from "../api-client";
import { envBadge, timeBadge } from "../ui/badges";
import { getBackendUrl } from "../config";

export interface TailOptions {
  filter?: string;
}

function eventBadge(event: string): string {
  const lower = event.toLowerCase();
  if (lower === "error" || lower.includes("error")) {
    return chalk.bgRed.white.bold(" ERROR ");
  }
  if (lower === "new_type" || lower.includes("new")) {
    return chalk.bgGreen.black.bold(" NEW_TYPE ");
  }
  if (lower === "type_changed" || lower.includes("changed")) {
    return chalk.bgYellow.black.bold(" TYPE_CHANGED ");
  }
  if (lower === "ingest" || lower.includes("ingest")) {
    return chalk.bgBlue.white.bold(" INGEST ");
  }
  return chalk.bgGray.white.bold(` ${event.toUpperCase()} `);
}

function formatEventDetail(event: TailEvent): string {
  const data = event.data;
  const parts: string[] = [];

  if (data.functionName) {
    parts.push(chalk.white.bold(String(data.functionName)));
  }

  if (data.module) {
    parts.push(chalk.gray(`(${data.module})`));
  }

  if (data.env) {
    parts.push(envBadge(String(data.env)));
  }

  if (data.error && typeof data.error === "object") {
    const err = data.error as Record<string, unknown>;
    if (err.message) {
      parts.push(chalk.red(String(err.message)));
    }
  }

  if (data.error_message) {
    parts.push(chalk.red(String(data.error_message)));
  }

  return parts.join("  ");
}

export async function tailCommand(opts: TailOptions): Promise<void> {
  const url = getBackendUrl();
  console.log(chalk.gray(`\n  Connecting to trickle at ${url}...`));

  const cleanup = tailEvents(
    (event: TailEvent) => {
      const now = new Date().toISOString();
      const timeStr = chalk.gray(
        now.replace(/T/, " ").replace(/\..+/, "")
      );
      const badge = eventBadge(event.event);
      const detail = formatEventDetail(event);

      console.log(`  ${timeStr}  ${badge}  ${detail}`);
    },
    opts.filter
  );

  // Give it a moment to connect, then show the listening message
  setTimeout(() => {
    console.log(chalk.green("  Listening for events...") + chalk.gray(" (Ctrl+C to stop)\n"));
  }, 500);

  // Keep the process alive and handle graceful shutdown
  const onSignal = () => {
    console.log(chalk.gray("\n  Disconnected.\n"));
    cleanup();
    process.exit(0);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Keep the event loop alive
  await new Promise<void>(() => {
    // Never resolves — the process stays alive until killed
  });
}
