import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = process.argv[2] ?? 'codeql-results';
const threshold = 7.0;
const sarifFiles = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.sarif') sarifFiles.push(path);
  }
}

function securityScore(rule) {
  const raw = rule?.properties?.['security-severity'];
  const score = Number(raw);
  return Number.isFinite(score) ? score : undefined;
}

function ruleMaps(run) {
  const byId = new Map();
  const byIndex = new Map();

  const components = [
    { component: run.tool?.driver, componentIndex: -1 },
    ...((run.tool?.extensions ?? []).map((component, componentIndex) => ({ component, componentIndex }))),
  ];

  for (const { component, componentIndex } of components) {
    for (const [ruleIndex, rule] of (component?.rules ?? []).entries()) {
      if (rule?.id) byId.set(rule.id, rule);
      byIndex.set(`${componentIndex}:${ruleIndex}`, rule);
    }
  }

  return { byId, byIndex };
}

function resolveRule(result, maps) {
  const ruleId = result.ruleId ?? result.rule?.id;
  if (ruleId && maps.byId.has(ruleId)) return maps.byId.get(ruleId);

  const ruleIndex = Number.isInteger(result.ruleIndex) ? result.ruleIndex : result.rule?.index;
  if (!Number.isInteger(ruleIndex)) return undefined;

  const componentIndex = Number.isInteger(result.rule?.toolComponent?.index)
    ? result.rule.toolComponent.index
    : -1;
  return maps.byIndex.get(`${componentIndex}:${ruleIndex}`)
    ?? maps.byIndex.get(`-1:${ruleIndex}`);
}

await walk(root);
if (!sarifFiles.length) {
  console.error(`CodeQL gate failed: no SARIF files were produced in ${root}.`);
  process.exit(1);
}

const serious = [];
for (const file of sarifFiles) {
  const sarif = JSON.parse(await readFile(file, 'utf8'));
  for (const run of sarif.runs ?? []) {
    const maps = ruleMaps(run);

    for (const result of run.results ?? []) {
      const rule = resolveRule(result, maps);
      const ruleId = result.ruleId ?? result.rule?.id ?? rule?.id ?? 'unknown-rule';
      const directScore = Number(result.properties?.['security-severity']);
      const score = Number.isFinite(directScore) ? directScore : securityScore(rule);
      if (typeof score === 'number' && score >= threshold) {
        const location = result.locations?.[0]?.physicalLocation;
        const uri = location?.artifactLocation?.uri ?? 'unknown-file';
        const line = location?.region?.startLine ?? '?';
        serious.push({ ruleId, score, uri, line, message: result.message?.text ?? '' });
      }
    }
  }
}

if (serious.length) {
  console.error(`CodeQL gate failed: ${serious.length} high/critical finding(s) scored ${threshold}+.`);
  for (const item of serious) {
    console.error(`- ${item.ruleId} (${item.score}) at ${item.uri}:${item.line}${item.message ? ` — ${item.message}` : ''}`);
  }
  process.exit(1);
}

console.log(`CodeQL gate passed: no high/critical findings scored ${threshold}+ across ${sarifFiles.length} SARIF file(s).`);
