/**
 * trickle cloud — upload/download observability data to a shared cloud endpoint.
 *
 * Commands:
 *   trickle cloud login              Generate API key and save config
 *   trickle cloud push               Upload .trickle/ data to the cloud
 *   trickle cloud pull               Download latest data from the cloud
 *   trickle cloud share              Create a shareable dashboard link
 *   trickle cloud status             Check cloud sync status
 *   trickle cloud projects           List all projects
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

// ── Config ──

interface CloudConfig {
  url: string;
  token: string;
}

function getConfigPath(): string {
  return path.join(process.env.HOME || '~', '.trickle', 'cloud.json');
}

function loadConfig(): CloudConfig {
  const configPath = getConfigPath();
  const envUrl = process.env.TRICKLE_CLOUD_URL;
  const envToken = process.env.TRICKLE_CLOUD_TOKEN;

  let fileConfig: Partial<CloudConfig> = {};
  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  return {
    url: envUrl || fileConfig.url || 'https://cloud.trickle.dev',
    token: envToken || fileConfig.token || '',
  };
}

function saveConfig(config: Partial<CloudConfig>): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  let existing: any = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...config }, null, 2), 'utf-8');
}

function findTrickleDir(): string {
  return process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
}

function readDataFiles(trickleDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const dataFiles = [
    'observations.jsonl', 'variables.jsonl', 'calltrace.jsonl',
    'queries.jsonl', 'errors.jsonl', 'console.jsonl', 'profile.jsonl',
    'traces.jsonl', 'websocket.jsonl', 'alerts.jsonl', 'heal.jsonl',
    'environment.json', 'baseline.json',
  ];
  for (const f of dataFiles) {
    const fp = path.join(trickleDir, f);
    if (fs.existsSync(fp)) {
      files[f] = fs.readFileSync(fp, 'utf-8');
    }
  }
  return files;
}

async function cloudFetch(urlPath: string, config: CloudConfig, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }
  return fetch(`${config.url}${urlPath}`, { ...options, headers });
}

// ── Commands ──

export async function cloudLogin(opts: { url?: string }): Promise<void> {
  const config = loadConfig();
  const url = opts.url || config.url;

  console.log('');
  console.log(chalk.bold('  trickle cloud login'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  // Generate a new API key
  console.log(`  Server: ${chalk.cyan(url)}`);
  console.log(`  Generating API key...`);

  try {
    const res = await fetch(`${url}/api/v1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `cli-${Date.now()}` }),
    });

    if (!res.ok) {
      console.log(chalk.red(`  Failed: ${res.status} ${res.statusText}`));
      return;
    }

    const data = await res.json() as any;
    saveConfig({ url, token: data.key });

    console.log(chalk.green(`  ✓ Logged in successfully`));
    console.log(`  Key: ${chalk.bold(data.prefix + '...')} (saved to ${chalk.gray(getConfigPath())})`);
    console.log('');
    console.log(chalk.gray('  You can now use:'));
    console.log(chalk.gray('    trickle cloud push    — upload observability data'));
    console.log(chalk.gray('    trickle cloud pull    — download project data'));
    console.log(chalk.gray('    trickle cloud share   — create shareable dashboard'));
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
      console.log(chalk.yellow(`  Cannot reach ${url}`));
      console.log(chalk.gray('  Make sure the trickle backend is running:'));
      console.log(chalk.gray(`    TRICKLE_CLOUD=1 npx trickle-backend`));
      console.log(chalk.gray('  Or set a custom URL:'));
      console.log(chalk.gray(`    trickle cloud login --url http://your-server:4888`));
    } else {
      console.log(chalk.red(`  Error: ${err.message}`));
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function cloudPush(): Promise<void> {
  const trickleDir = findTrickleDir();
  if (!fs.existsSync(trickleDir)) {
    console.log(chalk.yellow('  No .trickle/ directory found. Run your app with trickle first.'));
    return;
  }

  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  const files = readDataFiles(trickleDir);
  const fileCount = Object.keys(files).length;

  console.log('');
  console.log(chalk.bold('  trickle cloud push'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Uploading ${fileCount} data files...`);

  try {
    const res = await cloudFetch('/api/v1/push', config, {
      method: 'POST',
      body: JSON.stringify({
        project: path.basename(process.cwd()),
        files,
        timestamp: Date.now(),
      }),
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green(`  ✓ Uploaded ${data.files} files (${formatBytes(data.bytes)})`));
      if (data.url) console.log(`  Dashboard: ${chalk.cyan(data.url)}`);
    } else {
      const err = await res.json().catch(() => ({})) as any;
      console.log(chalk.red(`  ✗ Upload failed: ${res.status} — ${err.error || res.statusText}`));
    }
  } catch (err: any) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
      console.log(chalk.yellow(`  Cloud service not available at ${config.url}`));
      console.log(chalk.gray('  For local dashboards, use: trickle dashboard-local'));
    } else {
      console.log(chalk.red(`  ✗ Error: ${err.message}`));
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function cloudPull(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  const project = path.basename(process.cwd());

  console.log('');
  console.log(chalk.bold('  trickle cloud pull'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch(`/api/v1/pull?project=${encodeURIComponent(project)}`, config);

    if (res.ok) {
      const data = await res.json() as any;
      const trickleDir = findTrickleDir();
      fs.mkdirSync(trickleDir, { recursive: true });
      let count = 0;
      for (const [filename, content] of Object.entries(data.files || {})) {
        fs.writeFileSync(path.join(trickleDir, filename), content as string, 'utf-8');
        count++;
      }
      console.log(chalk.green(`  ✓ Downloaded ${count} files`));
      console.log(chalk.gray('  Run trickle status to see what was pulled.'));
    } else if (res.status === 404) {
      console.log(chalk.yellow(`  No data found for project "${project}"`));
      console.log(chalk.gray('  Push data first: trickle cloud push'));
    } else {
      console.log(chalk.red(`  ✗ Download failed: ${res.status}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available. Use trickle dashboard-local instead.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function cloudShare(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  const project = path.basename(process.cwd());

  console.log('');
  console.log(chalk.bold('  trickle cloud share'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch('/api/v1/share', config, {
      method: 'POST',
      body: JSON.stringify({ project, expiresInHours: 168 }), // 7 days
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green(`  ✓ Share link created`));
      console.log(`  URL: ${chalk.cyan(data.url)}`);
      if (data.expiresAt) {
        console.log(chalk.gray(`  Expires: ${new Date(data.expiresAt).toLocaleDateString()}`));
      }
    } else if (res.status === 404) {
      console.log(chalk.yellow(`  Project "${project}" not found. Push data first: trickle cloud push`));
    } else {
      console.log(chalk.red(`  ✗ Failed: ${res.status}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function cloudProjects(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cloud projects'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch('/api/v1/projects', config);

    if (res.ok) {
      const data = await res.json() as any;
      if (data.projects.length === 0) {
        console.log(chalk.gray('  No projects yet. Run trickle cloud push to create one.'));
      } else {
        for (const p of data.projects) {
          const size = formatBytes(p.size);
          const updated = new Date(p.updatedAt).toLocaleDateString();
          console.log(`  ${chalk.bold(p.name)} — ${p.files} files, ${size}, updated ${updated}`);
        }
      }
    } else {
      console.log(chalk.red(`  ✗ Failed: ${res.status}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function cloudStatus(): Promise<void> {
  const config = loadConfig();
  const trickleDir = findTrickleDir();

  console.log('');
  console.log(chalk.bold('  trickle cloud status'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Cloud URL: ${chalk.gray(config.url)}`);
  console.log(`  Auth: ${config.token ? chalk.green('configured') : chalk.yellow('not set — run trickle cloud login')}`);
  console.log(`  Local data: ${fs.existsSync(trickleDir) ? chalk.green('available') : chalk.yellow('none')}`);

  if (fs.existsSync(trickleDir)) {
    const files = readDataFiles(trickleDir);
    console.log(`  Files: ${Object.keys(files).length}`);
  }

  // Check connectivity
  if (config.token) {
    try {
      const res = await fetch(`${config.url}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`  Server: ${chalk.green('connected')}`);
      } else {
        console.log(`  Server: ${chalk.red('error ' + res.status)}`);
      }
    } catch {
      console.log(`  Server: ${chalk.yellow('unreachable')}`);
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

// ── Team commands ──

export async function teamCreate(opts: { name: string }): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cloud team create'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch('/api/v1/teams', config, {
      method: 'POST',
      body: JSON.stringify({ name: opts.name }),
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green(`  ✓ Team "${data.name}" created`));
      console.log(`  ID: ${chalk.cyan(data.id)}`);
      console.log(chalk.gray('  You are the owner. Invite members with:'));
      console.log(chalk.gray(`    trickle cloud team invite --team ${data.id} --key-id <their-key-id>`));
    } else {
      const err = await res.json().catch(() => ({})) as any;
      console.log(chalk.red(`  ✗ Failed: ${err.error || res.statusText}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function teamList(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cloud team list'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch('/api/v1/teams', config);

    if (res.ok) {
      const data = await res.json() as any;
      if (data.teams.length === 0) {
        console.log(chalk.gray('  No teams yet. Create one with: trickle cloud team create <name>'));
      } else {
        for (const t of data.teams) {
          const roleBadge = t.role === 'owner' ? chalk.green(t.role) :
            t.role === 'admin' ? chalk.cyan(t.role) :
            t.role === 'viewer' ? chalk.gray(t.role) : chalk.white(t.role);
          console.log(`  ${chalk.bold(t.name)} (${roleBadge}) — ${t.members} members, ${t.projects} projects`);
          console.log(chalk.gray(`    ID: ${t.id}`));
        }
      }
    } else {
      console.log(chalk.red(`  ✗ Failed: ${res.status}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function teamInfo(opts: { team: string }): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cloud team info'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch(`/api/v1/teams/${encodeURIComponent(opts.team)}`, config);

    if (res.ok) {
      const data = await res.json() as any;
      console.log(`  Team: ${chalk.bold(data.name)} (your role: ${data.role})`);
      console.log('');

      if (data.members.length > 0) {
        console.log(chalk.gray('  Members:'));
        for (const m of data.members) {
          const roleBadge = m.role === 'owner' ? chalk.green(m.role) :
            m.role === 'admin' ? chalk.cyan(m.role) :
            m.role === 'viewer' ? chalk.gray(m.role) : chalk.white(m.role);
          const email = m.email ? ` (${m.email})` : '';
          console.log(`    ${m.keyPrefix}... ${m.keyName}${email} — ${roleBadge}`);
        }
      }

      if (data.projects.length > 0) {
        console.log('');
        console.log(chalk.gray('  Projects:'));
        for (const p of data.projects) {
          console.log(`    ${chalk.bold(p.name)} — ${formatBytes(p.size)}, updated ${new Date(p.updatedAt).toLocaleDateString()}`);
        }
      }
    } else if (res.status === 404) {
      console.log(chalk.yellow(`  Team not found or you're not a member.`));
    } else {
      console.log(chalk.red(`  ✗ Failed: ${res.status}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function teamInvite(opts: { team: string; keyId: string; role?: string }): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  trickle cloud team invite'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));

  try {
    const res = await cloudFetch(`/api/v1/teams/${encodeURIComponent(opts.team)}/members`, config, {
      method: 'POST',
      body: JSON.stringify({ keyId: opts.keyId, role: opts.role || 'member' }),
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green(`  ✓ ${data.message}`));
    } else {
      const err = await res.json().catch(() => ({})) as any;
      console.log(chalk.red(`  ✗ ${err.error || res.statusText}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log('');
}

export async function teamRemove(opts: { team: string; keyId: string }): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  try {
    const res = await cloudFetch(`/api/v1/teams/${encodeURIComponent(opts.team)}/members/${encodeURIComponent(opts.keyId)}`, config, {
      method: 'DELETE',
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(chalk.green(`  ✓ ${data.message}`));
    } else {
      const err = await res.json().catch(() => ({})) as any;
      console.log(chalk.red(`  ✗ ${err.error || res.statusText}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }
}

export async function teamAddProject(opts: { team: string; project?: string }): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    console.log(chalk.yellow('  Not logged in. Run: trickle cloud login'));
    return;
  }

  const project = opts.project || path.basename(process.cwd());

  try {
    const res = await cloudFetch(`/api/v1/teams/${encodeURIComponent(opts.team)}/projects`, config, {
      method: 'POST',
      body: JSON.stringify({ project }),
    });

    if (res.ok) {
      console.log(chalk.green(`  ✓ Project "${project}" added to team`));
    } else {
      const err = await res.json().catch(() => ({})) as any;
      console.log(chalk.red(`  ✗ ${err.error || res.statusText}`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`  Cloud service not available.`));
  }
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
