import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DEFAULT_BACKEND_URL = "http://localhost:4888";

interface TrickleConfig {
  backendUrl?: string;
}

function loadConfigFile(): TrickleConfig | null {
  const configPath = path.join(os.homedir(), ".trickle", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as TrickleConfig;
    }
  } catch {
    // Ignore invalid config file
  }
  return null;
}

export function getBackendUrl(): string {
  // 1. Environment variable takes priority
  if (process.env.TRICKLE_BACKEND_URL) {
    return process.env.TRICKLE_BACKEND_URL.replace(/\/+$/, "");
  }

  // 2. Config file
  const config = loadConfigFile();
  if (config?.backendUrl) {
    return config.backendUrl.replace(/\/+$/, "");
  }

  // 3. Default
  return DEFAULT_BACKEND_URL;
}
