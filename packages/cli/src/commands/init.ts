import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import chalk from "chalk";

export interface InitOptions {
  dir?: string;
  python?: boolean;
}

interface ProjectInfo {
  dir: string;
  isPython: boolean;
  hasPackageJson: boolean;
  entryFile: string | null;
}

function detectProject(dir: string, forcePython: boolean): ProjectInfo {
  const info: ProjectInfo = {
    dir,
    isPython: forcePython,
    hasPackageJson: fs.existsSync(path.join(dir, "package.json")),
    entryFile: null,
  };

  if (
    fs.existsSync(path.join(dir, "pyproject.toml")) ||
    fs.existsSync(path.join(dir, "setup.py")) ||
    fs.existsSync(path.join(dir, "requirements.txt"))
  ) {
    info.isPython = true;
  }

  if (!info.isPython && info.hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
      const main = pkg.main as string | undefined;
      if (main && fs.existsSync(path.join(dir, main))) {
        info.entryFile = main;
      }
    } catch {
      // ignore
    }
    if (!info.entryFile) {
      for (const candidate of [
        "src/index.ts", "src/index.js", "index.ts", "index.js",
        "app.ts", "app.js", "server.ts", "server.js",
      ]) {
        if (fs.existsSync(path.join(dir, candidate))) {
          info.entryFile = candidate;
          break;
        }
      }
    }
  }

  if (info.isPython && !info.entryFile) {
    for (const candidate of ["app.py", "main.py", "server.py", "train.py"]) {
      if (fs.existsSync(path.join(dir, candidate))) {
        info.entryFile = candidate;
        break;
      }
    }
  }

  return info;
}

function pythonHasTrickle(): boolean {
  for (const py of ["python3", "python"]) {
    try {
      execSync(`${py} -c "import trickle"`, { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

function jsHasObserve(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "node_modules", "trickle-observe")) ||
    fs.existsSync(path.join(dir, "node_modules", "trickle"))
  );
}

function ensureTrickleDir(dir: string): void {
  const trickleDir = path.join(dir, ".trickle");
  if (!fs.existsSync(trickleDir)) {
    fs.mkdirSync(trickleDir, { recursive: true });
  }
}

function updateGitignore(dir: string): boolean {
  const giPath = path.join(dir, ".gitignore");
  let content = "";

  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, "utf-8");
    if (content.includes(".trickle")) return false;
  }

  const addition = content.endsWith("\n") || content === ""
    ? ".trickle/\n"
    : "\n.trickle/\n";

  fs.writeFileSync(giPath, content + addition, "utf-8");
  return true;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const dir = path.resolve(opts.dir || ".");

  console.log("");
  console.log(chalk.bold("  trickle init"));
  console.log("");

  const info = detectProject(dir, opts.python === true);

  if (!info.hasPackageJson && !info.isPython) {
    console.log(chalk.yellow("  No package.json or Python project detected."));
    console.log(chalk.gray("  Run this command from your project root, or pass --python.\n"));
    process.exit(1);
  }

  const lang = info.isPython ? "Python" : "JavaScript";
  console.log(chalk.gray(`  Detected: ${lang}`));
  if (info.entryFile) {
    console.log(chalk.gray(`  Entry:    ${info.entryFile}`));
  }
  console.log("");

  ensureTrickleDir(dir);
  console.log(`  ${chalk.green("+")} Created ${chalk.bold(".trickle/")} (runtime types land here)`);

  const giUpdated = updateGitignore(dir);
  if (giUpdated) {
    console.log(`  ${chalk.green("~")} Updated ${chalk.bold(".gitignore")} — added .trickle/`);
  } else {
    console.log(`  ${chalk.gray("-")} .gitignore already ignores .trickle/`);
  }

  console.log("");
  console.log(chalk.bold("  Install"));
  console.log("");

  if (info.isPython) {
    if (pythonHasTrickle()) {
      console.log(`  ${chalk.green("✓")} trickle-observe is already importable`);
    } else {
      console.log(chalk.white("  Install the Python tracer:"));
      console.log(chalk.cyan("    pip install trickle-observe"));
    }
  } else {
    if (jsHasObserve(dir)) {
      console.log(`  ${chalk.green("✓")} trickle-observe is already installed`);
    } else {
      console.log(chalk.white("  Install the JS tracer in this project:"));
      console.log(chalk.cyan("    npm install trickle-observe"));
    }
  }

  console.log("");
  console.log(chalk.white("  Optional — inline types in the editor:"));
  console.log(chalk.cyan("    code --install-extension yiheinchai.trickle-vscode"));

  const entryFile = info.entryFile || (info.isPython ? "app.py" : "app.js");
  const runExample = info.isPython
    ? `trickle run ${entryFile}`
    : `trickle run ${entryFile}`;

  console.log("");
  console.log(chalk.bold("  See types"));
  console.log("");
  console.log(chalk.white("  1. Run your code:"));
  console.log(chalk.cyan(`     ${runExample}`));
  console.log("");
  console.log(chalk.white("  2. Open the file in VSCode (inline hints), a Jupyter notebook,"));
  console.log(chalk.white("     or print types in the terminal:"));
  console.log(chalk.cyan("     trickle hints"));
  console.log(chalk.cyan("     trickle vars"));
  console.log("");
}
