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

await walk(root);
if (!sarifFiles.length) {
  console.error(`CodeQL gate failed: no SARIF files were produced in ${root}.`);
  process.exit(1);
}

const serious = [];
for (const file of sarifFiles) {
  const sarif = JSON.parse(await readFile(file, 'utf8'));
  for (const run of sarif.runs ?? []) {
    const scores = new Map();
    for (const rule of run.tool?.driver?.rules ?? []) {
      const raw = rule.properties?.['security-severity'];
      const score = Number(raw);
      if (rule.id && Number.isFinite(score)) scores.set(rule.id, score);
    }

    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown-rule';
      const directScore = Number(result.properties?.['security-severity']);
      const score = Number.isFinite(directScore) ? directScore : scores.get(ruleId);
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
