/**
 * trickle audit --compliance — Generate compliance audit report.
 *
 * Exports trickle's JSONL data as a structured compliance report for
 * EU AI Act and Colorado AI Act requirements:
 * - Decision lineage (LLM call → tool call → output)
 * - Timestamped event log
 * - Risk classification
 * - Security scan results
 * - Data processing summary
 *
 * Local-first: sensitive audit data never leaves the developer's machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

interface ComplianceReport {
  meta: {
    generatedAt: string;
    trickleVersion: string;
    framework: string;
    dataDir: string;
  };
  riskClassification: {
    level: 'high' | 'medium' | 'low';
    factors: string[];
  };
  decisionLineage: Array<{
    timestamp: number;
    event: string;
    description: string;
    data?: Record<string, unknown>;
  }>;
  dataProcessing: {
    llmProviders: string[];
    modelsUsed: string[];
    totalLlmCalls: number;
    totalTokens: number;
    estimatedCost: number;
    toolsUsed: string[];
    mcpToolsUsed: string[];
    dataSourcesAccessed: string[];
  };
  securityFindings: Array<{
    severity: string;
    category: string;
    message: string;
    evidence: string;
  }>;
  evalScore: {
    overall: number;
    grade: string;
    dimensions: Record<string, number>;
  } | null;
  humanOversight: {
    hasHumanInLoop: boolean;
    approvalCheckpoints: number;
    escalationEvents: number;
  };
}

export async function generateComplianceReport(opts: { json?: boolean; out?: string }): Promise<void> {
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  if (!fs.existsSync(dir)) {
    console.log(chalk.yellow('  No .trickle/ data. Run trickle first.'));
    return;
  }

  const llmCalls = readJsonl(path.join(dir, 'llm.jsonl'));
  const agentEvents = readJsonl(path.join(dir, 'agents.jsonl'));
  const mcpCalls = readJsonl(path.join(dir, 'mcp.jsonl'));
  const errors = readJsonl(path.join(dir, 'errors.jsonl'));
  const observations = readJsonl(path.join(dir, 'observations.jsonl'));
  const calltrace = readJsonl(path.join(dir, 'calltrace.jsonl'));

  // Build decision lineage — chronological event log
  const lineage: ComplianceReport['decisionLineage'] = [];

  for (const e of agentEvents) {
    lineage.push({
      timestamp: e.timestamp || 0,
      event: `agent:${e.event}`,
      description: buildAgentDescription(e),
      data: { framework: e.framework, tool: e.tool, chain: e.chain },
    });
  }

  for (const c of llmCalls) {
    lineage.push({
      timestamp: c.timestamp || 0,
      event: 'llm:call',
      description: `${c.provider}/${c.model}: ${(c.inputPreview || '').substring(0, 80)} → ${(c.outputPreview || '').substring(0, 80)}`,
      data: { model: c.model, tokens: c.totalTokens, cost: c.estimatedCostUsd, error: c.error },
    });
  }

  for (const m of mcpCalls) {
    if (m.tool === '__list_tools') continue;
    lineage.push({
      timestamp: m.timestamp || 0,
      event: `mcp:${m.direction}`,
      description: `${m.tool}(${JSON.stringify(m.args || {}).substring(0, 60)}) → ${(m.resultPreview || '').substring(0, 60)}`,
      data: { tool: m.tool, direction: m.direction, isError: m.isError },
    });
  }

  lineage.sort((a, b) => a.timestamp - b.timestamp);

  // Data processing summary
  const providers = [...new Set(llmCalls.map(c => c.provider).filter(Boolean))];
  const models = [...new Set(llmCalls.map(c => `${c.provider}/${c.model}`).filter(Boolean))];
  const totalTokens = llmCalls.reduce((s: number, c: any) => s + (c.totalTokens || 0), 0);
  const totalCost = llmCalls.reduce((s: number, c: any) => s + (c.estimatedCostUsd || 0), 0);
  const agentTools = [...new Set(agentEvents.filter(e => e.tool).map(e => e.tool))];
  const mcpTools = [...new Set(mcpCalls.filter(c => c.tool && c.tool !== '__list_tools').map(c => c.tool))];
  const dataSources = [...new Set(observations.map(o => o.module).filter(Boolean))];

  // Security scan
  let securityFindings: ComplianceReport['securityFindings'] = [];
  try {
    const { runSecurityScan } = require('./security');
    const origLog = console.log;
    console.log = () => {};
    const result = await runSecurityScan({ dir });
    console.log = origLog;
    securityFindings = result.findings.map((f: any) => ({
      severity: f.severity, category: f.category,
      message: f.message, evidence: (f.evidence || '').substring(0, 100),
    }));
  } catch {}

  // Eval score
  let evalScore: ComplianceReport['evalScore'] = null;
  try {
    const { evalCommand } = require('./eval');
    // We can't easily call evalCommand and get the result, so build a lightweight score
    const completionRate = agentEvents.filter(e => e.event === 'crew_end').length /
      Math.max(1, agentEvents.filter(e => e.event === 'crew_start').length);
    const errorRate = errors.length / Math.max(1, lineage.length);
    evalScore = {
      overall: Math.round(Math.max(0, (1 - errorRate) * completionRate * 100)),
      grade: completionRate >= 0.9 && errorRate < 0.1 ? 'A' : completionRate >= 0.7 ? 'B' : 'C',
      dimensions: { completion: Math.round(completionRate * 100), errorRate: Math.round((1 - errorRate) * 100) },
    };
  } catch {}

  // Risk classification
  const riskFactors: string[] = [];
  if (llmCalls.length > 0) riskFactors.push('Uses AI/LLM for decision-making');
  if (agentEvents.length > 0) riskFactors.push('Autonomous agent workflow');
  if (agentTools.length > 0) riskFactors.push(`Executes ${agentTools.length} tools autonomously`);
  if (securityFindings.filter(f => f.severity === 'critical').length > 0) riskFactors.push('Critical security findings');
  if (errors.length > 0) riskFactors.push(`${errors.length} runtime errors`);
  const riskLevel: 'high' | 'medium' | 'low' = riskFactors.length >= 3 ? 'high' : riskFactors.length >= 1 ? 'medium' : 'low';

  // Human oversight
  const permissionEvents = agentEvents.filter(e =>
    e.event === 'permission_request' || (e.tool || '').toLowerCase().includes('approval'));
  const escalationEvents = agentEvents.filter(e =>
    e.event?.includes('error') || e.event === 'crew_error');

  const report: ComplianceReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      trickleVersion: 'CLI 0.1.191',
      framework: [...new Set(agentEvents.map(e => e.framework).filter(Boolean))].join(', ') || 'N/A',
      dataDir: dir,
    },
    riskClassification: { level: riskLevel, factors: riskFactors },
    decisionLineage: lineage,
    dataProcessing: {
      llmProviders: providers, modelsUsed: models,
      totalLlmCalls: llmCalls.length, totalTokens, estimatedCost: Math.round(totalCost * 10000) / 10000,
      toolsUsed: agentTools, mcpToolsUsed: mcpTools,
      dataSourcesAccessed: dataSources.slice(0, 20),
    },
    securityFindings,
    evalScore,
    humanOversight: {
      hasHumanInLoop: permissionEvents.length > 0,
      approvalCheckpoints: permissionEvents.length,
      escalationEvents: escalationEvents.length,
    },
  };

  // Output
  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify(report, null, 2), 'utf-8');
    console.log(chalk.green(`  Compliance report written to ${opts.out}`));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Pretty print
  console.log('');
  console.log(chalk.bold('  trickle audit --compliance'));
  console.log(chalk.gray('  ' + '─'.repeat(60)));

  const riskColor = riskLevel === 'high' ? chalk.red : riskLevel === 'medium' ? chalk.yellow : chalk.green;
  console.log(`  Risk: ${riskColor(riskLevel.toUpperCase())} (${riskFactors.length} factors)`);
  for (const f of riskFactors) console.log(chalk.gray(`    • ${f}`));

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  Data Processing'));
  console.log(`  LLM providers: ${providers.join(', ') || 'none'}`);
  console.log(`  Models: ${models.join(', ') || 'none'}`);
  console.log(`  Calls: ${llmCalls.length}  Tokens: ${totalTokens}  Cost: $${totalCost.toFixed(4)}`);
  console.log(`  Tools: ${agentTools.join(', ') || 'none'}`);
  if (mcpTools.length > 0) console.log(`  MCP tools: ${mcpTools.join(', ')}`);

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  Decision Lineage'));
  console.log(`  ${lineage.length} events recorded`);
  for (const e of lineage.slice(0, 10)) {
    const ts = new Date(e.timestamp).toISOString().substring(11, 23);
    console.log(chalk.gray(`  ${ts}`) + ` ${e.event.padEnd(20)} ${e.description.substring(0, 60)}`);
  }
  if (lineage.length > 10) console.log(chalk.gray(`  ... and ${lineage.length - 10} more`));

  if (securityFindings.length > 0) {
    console.log(chalk.gray('\n  ' + '─'.repeat(60)));
    console.log(chalk.bold('  Security'));
    const crit = securityFindings.filter(f => f.severity === 'critical').length;
    const warn = securityFindings.filter(f => f.severity === 'warning').length;
    console.log(`  ${chalk.red(String(crit))} critical, ${chalk.yellow(String(warn))} warnings`);
  }

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.bold('  Human Oversight'));
  console.log(`  Human-in-the-loop: ${report.humanOversight.hasHumanInLoop ? chalk.green('Yes') : chalk.yellow('No')}`);
  console.log(`  Approval checkpoints: ${report.humanOversight.approvalCheckpoints}`);
  console.log(`  Escalation events: ${report.humanOversight.escalationEvents}`);

  console.log(chalk.gray('\n  ' + '─'.repeat(60)));
  console.log(chalk.gray('  Export: trickle audit --compliance --json > audit-report.json'));
  console.log(chalk.gray('  Export: trickle audit --compliance -o audit-report.json'));
  console.log('');
}

function buildAgentDescription(e: any): string {
  const parts: string[] = [];
  if (e.chain) parts.push(e.chain);
  if (e.tool) parts.push(`tool:${e.tool}`);
  if (e.toolInput) parts.push(`input:${String(e.toolInput).substring(0, 40)}`);
  if (e.output) parts.push(`output:${String(e.output).substring(0, 40)}`);
  if (e.error) parts.push(`error:${String(e.error).substring(0, 40)}`);
  if (e.thought) parts.push(`thought:${String(e.thought).substring(0, 40)}`);
  return parts.join(' | ') || e.event || '?';
}
