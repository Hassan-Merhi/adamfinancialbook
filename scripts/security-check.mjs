import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'backups']);
const ignoredFiles = new Set(['.env.example', 'scripts/security-check.mjs']);
const textExtensions = new Set([
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.sql', '.html', '.css', '.txt', '.sh', '.toml', '.ini', '.conf',
]);

const detectors = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ['credentialed database URL', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s/@]+@/i],
];

const findings = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    const repoPath = relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(repoPath)) continue;

    if (entry.name.startsWith('.env')) {
      findings.push(`${repoPath}: tracked runtime environment file`);
      continue;
    }

    if (!textExtensions.has(extname(entry.name).toLowerCase())) continue;
    const info = await stat(absolute);
    if (info.size > 1_000_000) continue;
    const text = await readFile(absolute, 'utf8');
    for (const [label, pattern] of detectors) {
      if (pattern.test(text)) findings.push(`${repoPath}: possible ${label}`);
    }
  }
}

await walk(root);

if (findings.length) {
  console.error('Security check failed. Possible secrets or unsafe env files were found:');
  for (const finding of findings) console.error(`- ${finding}`);
  console.error('Remove the secret from the repository and rotate it if it was ever real.');
  process.exit(1);
}

console.log('Security check passed: no tracked runtime env files or obvious credential patterns found.');
