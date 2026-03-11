import chalk from "chalk";
import { getBackendUrl } from "../config";

export async function dashboardCommand(): Promise<void> {
  const backendUrl = getBackendUrl();
  const dashboardUrl = `${backendUrl}/dashboard`;

  // Check backend is reachable
  try {
    const res = await fetch(`${backendUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
  } catch {
    console.error(chalk.red(`\n  Cannot reach trickle backend at ${chalk.bold(backendUrl)}`));
    console.error(chalk.gray("  Start the backend first: cd packages/backend && npm start\n"));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.bold("  trickle dashboard"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Opening ${chalk.bold(dashboardUrl)}`));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Open in browser
  const { exec } = await import("child_process");
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${dashboardUrl}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${dashboardUrl}"`;
  } else {
    cmd = `xdg-open "${dashboardUrl}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      console.log(chalk.yellow(`  Could not open browser automatically.`));
      console.log(chalk.yellow(`  Open this URL manually: ${dashboardUrl}\n`));
    }
  });

  // Keep the process alive briefly so the user sees the message
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
