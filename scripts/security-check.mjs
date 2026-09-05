import { readdir, readFile } from 'node:fs/promises';
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
];

const databaseUrlPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]+/gi;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const findings = [];

function hasRemoteDatabaseCredentials(text) {
  for (const match of text.matchAll(databaseUrlPattern)) {
    const candidate = match[0].replace(/[),;]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.username && url.password && !loopbackHosts.has(url.hostname.toLowerCase())) return true;
    } catch {
      // If a credential-looking DB URL cannot be parsed safely, flag it rather than ignore it.
      if (/\/\/[^\s:/@]+:[^\s/@]+@/.test(candidate)) return true;
    }
  }
  return false;
}

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
    // Read once and make all decisions from the bytes we actually scanned. This
    // avoids a check-then-read race where a file could change between stat/read.
    const text = await readFile(absolute, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > 1_000_000) continue;
    for (const [label, pattern] of detectors) {
      if (pattern.test(text)) findings.push(`${repoPath}: possible ${label}`);
    }
    if (hasRemoteDatabaseCredentials(text)) {
      findings.push(`${repoPath}: possible credentialed remote database URL`);
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
