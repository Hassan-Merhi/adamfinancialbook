import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = join(process.cwd(), '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name));
const usesPattern = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm;
const fullCommitSha = /^[^/@\s]+\/[^@\s]+@[a-f0-9]{40}$/i;

describe('GitHub Actions supply-chain pinning', () => {
  it('pins every external action to an immutable full commit SHA', () => {
    const floating: string[] = [];

    for (const file of workflowFiles) {
      const workflow = readFileSync(join(workflowsDir, file), 'utf8');
      for (const match of workflow.matchAll(usesPattern)) {
        const reference = match[1];
        if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
        if (!fullCommitSha.test(reference)) floating.push(`${file}: ${reference}`);
      }
    }

    expect(floating, `Floating GitHub Action refs found:\n${floating.join('\n')}`).toEqual([]);
  });
});
