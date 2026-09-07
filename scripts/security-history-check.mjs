import { spawnSync } from 'node:child_process';

const git = spawnSync(
  'git',
  [
    'log',
    '--all',
    '--format=@@COMMIT@@%H',
    '-p',
    '--no-ext-diff',
    '--no-renames',
    '--',
    '.',
    ':(exclude)package-lock.json',
    ':(exclude)scripts/security-check.mjs',
    ':(exclude)scripts/security-history-check.mjs',
  ],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
);

if (git.error) {
  console.error(`Historical secret scan could not run git: ${git.error.message}`);
  process.exit(1);
}
if (git.status !== 0) {
  console.error('Historical secret scan could not read repository history.');
  if (git.stderr) console.error(git.stderr.trim());
  process.exit(git.status ?? 1);
}

const detectors = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
  ['Stripe live secret', /\bsk_live_[0-9A-Za-z]{16,}\b/],
];

const databaseUrlPattern = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"`<>]+/gi;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const sensitiveNames = 'APP_TOKEN|SESSION_SECRET|MFA_ENCRYPTION_KEY|BACKUP_ENCRYPTION_KEY|ANTHROPIC_API_KEY|GOOGLE_TRANSLATE_API_KEY';
const quotedAssignmentPattern = new RegExp(`\\b(${sensitiveNames})\\s*=\\s*(['"])([^'"]+)\\2`, 'i');
const bareAssignmentPattern = new RegExp(`\\b(${sensitiveNames})\\s*=\\s*([^\\s'"\\x60#;\\\\]+)`, 'i');
const knownPlaceholderValues = new Set([
  'changeme',
  'change-me',
  'example',
  'placeholder',
  'password',
  'secret',
  'test',
  'anything-long-for-now',
  'stable-production-backup-key',
  'the-stable-backup-key',
]);

function containsCredentialedRemoteDatabaseUrl(text) {
  for (const match of text.matchAll(databaseUrlPattern)) {
    const candidate = match[0].replace(/[),;]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.username && url.password && !loopbackHosts.has(url.hostname.toLowerCase())) return true;
    } catch {
      if (/\/\/[^\s:/@]+:[^\s/@]+@/.test(candidate)) return true;
    }
  }
  return false;
}

function looksLikePlaceholder(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (knownPlaceholderValues.has(normalized)) return true;
  if (normalized.startsWith('${') || normalized.startsWith('$')) return true;
  if (normalized.includes('placeholder') || normalized.includes('example')) return true;
  if (normalized.includes('for-the-test') || normalized.includes('-test-secret') || normalized.includes('-ci-')) return true;
  return false;
}

function containsSensitiveAssignment(text, repoPath) {
  // Exact provider-token/private-key detectors above still run inside tests. The
  // generic assignment heuristic is skipped for test fixtures because those
  // files deliberately need fake SESSION_SECRET / encryption-key literals.
  if (/\.(?:integration\.)?test\.[cm]?[jt]sx?$/i.test(repoPath)) return false;

  const quoted = text.match(quotedAssignmentPattern);
  if (quoted) return !looksLikePlaceholder(quoted[3]);

  const bare = text.match(bareAssignmentPattern);
  if (!bare) return false;
  const value = bare[2].trim();

  // Avoid treating normal source-code variable assignments such as
  // process.env.KEY = oldKey as literal credentials. Runtime env files and shell
  // snippets still get checked because their values are not source identifiers.
  if (/process\.env\./.test(text) && /^[A-Za-z_$][\w$.[\]!?]*$/.test(value)) return false;
  return !looksLikePlaceholder(value);
}

const findings = new Map();
let commit = 'unknown';
let path = 'unknown';

function record(label) {
  const key = `${commit}:${path}:${label}`;
  findings.set(key, { commit, path, label });
}

for (const line of git.stdout.split('\n')) {
  if (line.startsWith('@@COMMIT@@')) {
    commit = line.slice('@@COMMIT@@'.length).trim() || 'unknown';
    path = 'unknown';
    continue;
  }

  const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (diffMatch) {
    path = diffMatch[2];
    continue;
  }

  if (!(line.startsWith('+') || line.startsWith('-'))) continue;
  if (line.startsWith('+++') || line.startsWith('---')) continue;
  const text = line.slice(1);

  for (const [label, pattern] of detectors) {
    if (pattern.test(text)) record(label);
  }
  if (containsCredentialedRemoteDatabaseUrl(text)) record('credentialed remote database URL');
  if (containsSensitiveAssignment(text, path)) record('literal sensitive environment assignment');
}

if (findings.size) {
  console.error(`Historical secret scan failed: ${findings.size} possible exposure location(s) found.`);
  console.error('Values are intentionally not printed. Review each location and rotate/revoke any credential that was ever real.');
  for (const finding of [...findings.values()].slice(0, 50)) {
    console.error(`- ${finding.commit.slice(0, 12)} ${finding.path}: ${finding.label}`);
  }
  if (findings.size > 50) console.error(`- ...and ${findings.size - 50} more location(s)`);
  process.exit(1);
}

console.log('Historical secret scan passed: no obvious credentials were found in reachable Git history.');
