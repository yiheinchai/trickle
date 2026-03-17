import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchMockConfig, fetchCodegen, listFunctions, MockRoute } from "../api-client";
import { isLocalMode, getLocalMockRoutes, getLocalFunctions } from "../local-data";
import { generateFromJsonl } from "../local-codegen";

export interface DocsOptions {
  out?: string;
  html?: boolean;
  env?: string;
  title?: string;
  local?: boolean;
}

/**
 * `trickle docs` — Generate API documentation from observed runtime types.
 *
 * Produces clean Markdown (or self-contained HTML) documenting every
 * observed API route with request/response types and example payloads.
 */
export async function docsCommand(opts: DocsOptions): Promise<void> {
  const title = opts.title || "API Documentation";

  // Fetch data
  let routes: MockRoute[];
  let typesContent: string;
  let totalFunctions: number;

  if (isLocalMode(opts)) {
    const jsonlPath = path.join(process.cwd(), ".trickle", "observations.jsonl");
    const mockResult = getLocalMockRoutes();
    routes = mockResult.routes;
    const stubs = generateFromJsonl(jsonlPath);
    const sections: string[] = [];
    for (const [_mod, content] of Object.entries(stubs)) {
      sections.push(content.ts);
    }
    typesContent = sections.join("\n");
    totalFunctions = getLocalFunctions({ env: opts.env }).total;
  } else {
    try {
      const [mockConfig, codegen, funcList] = await Promise.all([
        fetchMockConfig(),
        fetchCodegen({ env: opts.env }),
        listFunctions({ env: opts.env, limit: 500 }),
      ]);
      routes = mockConfig.routes;
      typesContent = codegen.types;
      totalFunctions = funcList.total;
    } catch {
      console.error(chalk.red("\n  Cannot connect to trickle backend."));
      console.error(chalk.gray("  Is the backend running?\n"));
      process.exit(1);
    }
  }

  if (routes.length === 0) {
    console.error(chalk.yellow("\n  No observed API routes to document."));
    console.error(chalk.gray("  Instrument your app and make some requests first.\n"));
    process.exit(0);
  }

  // Parse type definitions to map route names to their types
  const typeMap = buildTypeMap(typesContent);

  // Group routes by resource
  const groups = groupRoutesByResource(routes);

  // Generate markdown
  const markdown = generateMarkdown(title, groups, typeMap, totalFunctions);

  if (opts.html) {
    const html = wrapInHtml(title, markdown);
    if (opts.out) {
      fs.writeFileSync(opts.out, html, "utf-8");
      console.log(chalk.green(`\n  API docs written to ${chalk.bold(opts.out)}`));
      console.log(chalk.gray(`  ${routes.length} routes documented\n`));
    } else {
      console.log(html);
    }
  } else {
    if (opts.out) {
      fs.writeFileSync(opts.out, markdown, "utf-8");
      console.log(chalk.green(`\n  API docs written to ${chalk.bold(opts.out)}`));
      console.log(chalk.gray(`  ${routes.length} routes documented\n`));
    } else {
      console.log(markdown);
    }
  }
}

interface RouteGroup {
  resource: string;
  routes: MockRoute[];
}

function groupRoutesByResource(routes: MockRoute[]): RouteGroup[] {
  const groups: Record<string, MockRoute[]> = {};

  for (const route of routes) {
    const parts = route.path.split("/").filter(Boolean);
    let resource: string;
    if (parts[0] === "api" && parts.length >= 2) {
      resource = `/${parts[0]}/${parts[1]}`;
    } else {
      resource = `/${parts[0] || "root"}`;
    }

    if (!groups[resource]) groups[resource] = [];
    groups[resource].push(route);
  }

  // Sort groups alphabetically, routes by method order
  const methodOrder: Record<string, number> = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
  const result: RouteGroup[] = [];

  for (const [resource, resourceRoutes] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
    resourceRoutes.sort((a, b) => {
      const ma = methodOrder[a.method] ?? 5;
      const mb = methodOrder[b.method] ?? 5;
      if (ma !== mb) return ma - mb;
      return a.path.localeCompare(b.path);
    });
    result.push({ resource, routes: resourceRoutes });
  }

  return result;
}

/**
 * Extract type definitions from generated TypeScript code and map them
 * to route function names.
 */
function buildTypeMap(typesContent: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!typesContent) return map;

  // Find interface/type blocks and their associated route comments
  const blocks = typesContent.split(/(?=\/\*\*|export interface|export type)/);

  let currentComment = "";
  for (const block of blocks) {
    if (block.startsWith("/**")) {
      currentComment = block;
      continue;
    }

    const match = block.match(/export (?:interface|type) (\w+)/);
    if (match) {
      const typeName = match[1];
      // Clean up the block
      const cleanBlock = block.trim();
      if (cleanBlock) {
        map.set(typeName, cleanBlock);
      }
    }
    currentComment = "";
  }

  return map;
}

function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function generateMarkdown(
  title: string,
  groups: RouteGroup[],
  typeMap: Map<string, string>,
  totalFunctions: number,
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().split("T")[0];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Auto-generated by [trickle](https://github.com/yiheinchai/trickle) from runtime-observed types.`);
  lines.push(`> Generated on ${now} — ${totalFunctions} functions observed.`);
  lines.push("");

  // Table of contents
  lines.push("## Table of Contents");
  lines.push("");
  for (const group of groups) {
    const anchor = group.resource.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    lines.push(`- [${group.resource}](#${anchor})`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Route groups
  for (const group of groups) {
    lines.push(`## ${group.resource}`);
    lines.push("");

    for (const route of group.routes) {
      const methodBadge = `\`${route.method}\``;
      lines.push(`### ${methodBadge} ${route.path}`);
      lines.push("");

      // Metadata
      const observed = route.observedAt ? new Date(route.observedAt).toISOString().split("T")[0] : "unknown";
      lines.push(`*Last observed: ${observed}*`);
      lines.push("");

      // Request body
      const hasBody = ["POST", "PUT", "PATCH"].includes(route.method);
      if (hasBody && route.sampleInput) {
        const input = route.sampleInput as Record<string, unknown>;
        const body = input.body || input;
        if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
          lines.push("**Request Body**");
          lines.push("");
          lines.push("```typescript");
          lines.push(formatTypeFromSample(body));
          lines.push("```");
          lines.push("");
          lines.push("<details>");
          lines.push("<summary>Example</summary>");
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(body, null, 2));
          lines.push("```");
          lines.push("</details>");
          lines.push("");
        }
      }

      // Response
      if (route.sampleOutput) {
        // Try to find the TypeScript type
        const typeName = toPascalCase(route.functionName);
        const responseTypeName = typeName + "Response";
        const typeBlock = typeMap.get(responseTypeName);

        lines.push("**Response**");
        lines.push("");

        if (typeBlock) {
          lines.push("```typescript");
          lines.push(typeBlock);
          lines.push("```");
        } else {
          lines.push("```typescript");
          lines.push(formatTypeFromSample(route.sampleOutput));
          lines.push("```");
        }
        lines.push("");

        lines.push("<details>");
        lines.push("<summary>Example Response</summary>");
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(route.sampleOutput, null, 2));
        lines.push("```");
        lines.push("</details>");
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  }

  // Footer
  lines.push("*Generated by trickle — runtime type observability for JavaScript and Python.*");
  lines.push("");

  return lines.join("\n");
}

/**
 * Infer a TypeScript type string from a sample JSON value.
 */
function formatTypeFromSample(value: unknown, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null) return `${pad}null`;
  if (value === undefined) return `${pad}undefined`;

  switch (typeof value) {
    case "string": return `${pad}string`;
    case "number": return `${pad}number`;
    case "boolean": return `${pad}boolean`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}unknown[]`;
    const elementType = formatTypeFromSample(value[0], 0);
    if (elementType.includes("\n")) {
      // Multi-line element
      return `${pad}Array<${formatTypeFromSample(value[0], indent).trimStart()}>`;
    }
    return `${pad}${elementType.trim()}[]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return `${pad}{}`;

    const lines: string[] = [];
    lines.push(`${pad}{`);
    for (const key of keys) {
      const val = obj[key];
      const valType = formatTypeFromSample(val, indent + 1).trimStart();
      lines.push(`${pad}  ${key}: ${valType};`);
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  }

  return `${pad}unknown`;
}

/**
 * Wrap markdown in a self-contained HTML document with a simple renderer.
 */
function wrapInHtml(title: string, markdown: string): string {
  // Escape for embedding in JS
  const escapedMd = markdown
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    line-height: 1.6; color: #1a1a2e; background: #fafafa;
    max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem;
  }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
  h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 0.75rem; color: #2d3748; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
  h3 { font-size: 1.1rem; margin-top: 1.5rem; margin-bottom: 0.5rem; }
  p { margin-bottom: 0.75rem; }
  blockquote { border-left: 3px solid #cbd5e0; padding-left: 1rem; color: #718096; margin-bottom: 1rem; }
  code { background: #f0f0f0; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #1a1a2e; color: #e2e8f0; padding: 1rem; border-radius: 6px; overflow-x: auto; margin-bottom: 1rem; }
  pre code { background: none; padding: 0; color: inherit; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0; }
  em { color: #718096; }
  strong { color: #2d3748; }
  ul { padding-left: 1.5rem; margin-bottom: 0.75rem; }
  li { margin-bottom: 0.25rem; }
  a { color: #3182ce; text-decoration: none; }
  a:hover { text-decoration: underline; }
  details { margin-bottom: 1rem; }
  summary { cursor: pointer; color: #3182ce; font-weight: 500; margin-bottom: 0.5rem; }
  summary:hover { text-decoration: underline; }
  /* Method badges */
  code:first-child { font-weight: bold; }
</style>
</head>
<body>
<div id="content"></div>
<script>
// Simple markdown renderer
function renderMd(md) {
  let html = md;
  // Code blocks (fenced)
  html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code class="lang-$1">$2</code></pre>');
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
  // HR
  html = html.replace(/^---$/gm, '<hr>');
  // Details/summary (passthrough)
  // Paragraphs
  html = html.replace(/^(?!<[hupbold]|<li|<ul|<hr|<details|<summary|<\\/|<pre|<blockquote)(.+)$/gm, '<p>$1</p>');
  return html;
}
const md = \`${escapedMd}\`;
document.getElementById('content').innerHTML = renderMd(md);
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
