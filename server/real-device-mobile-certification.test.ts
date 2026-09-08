import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 3 real-device mobile certification', () => {
  it('keeps a manual exact-SHA physical-device gate', () => {
    const workflow = read('.github/workflows/real-device-mobile-certification.yml');

    expect(workflow).toContain('name: Real Device Mobile Certification');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('target_sha:');
    expect(workflow).toContain('iphone_model:');
    expect(workflow).toContain('android_model:');
    expect(workflow).toContain('evidence_url:');
    expect(workflow).toContain('create_transaction:');
    expect(workflow).toContain('transfer_money:');
    expect(workflow).toContain('correct_entry:');
    expect(workflow).toContain('void_entry:');
    expect(workflow).toContain('offline_reconnect:');
    expect(workflow).toContain('receipt_upload:');
    expect(workflow).toContain('realtime_refresh:');
    expect(workflow).toContain('pull_to_refresh:');
    expect(workflow).toContain('rotation_keyboard:');
    expect(workflow).toContain('navigation_layout:');
    expect(workflow).toContain('if [ "$TARGET_SHA" != "$EXPECTED_SHA" ]');
    expect(workflow).toContain('real-device-mobile-certification-${{ inputs.target_sha }}');
    expect(workflow).toMatch(/uses:\s*actions\/upload-artifact@[a-f0-9]{40}/);
  });

  it('makes stable release depend on exact-SHA physical-device evidence', () => {
    const release = read('.github/workflows/stable-release-tag.yml');

    expect(release).toContain("'Real Device Mobile Certification'");
    expect(release).toContain("real-device-mobile-certification-{expected_sha}");
    expect(release).toContain('Real-device workflow is green but no retained exact-SHA mobile certification artifact was found.');
    expect(release).toContain("'mobileArtifactId': mobile.get('id')");
  });

  it('documents the physical-device procedure', () => {
    const doc = read('docs/real-device-mobile-certification.md');

    expect(doc).toContain('physical iPhone');
    expect(doc).toContain('physical Android phone');
    expect(doc).toContain('Correct an entry');
    expect(doc).toContain('Void an entry');
    expect(doc).toContain('Go offline');
    expect(doc).toContain('background realtime refresh');
    expect(doc).toContain('Pull down from the top');
    expect(doc).toContain('software keyboard');
  });
});
