import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Advanced offline Phase 2 contract', () => {
  it('keeps the confirmed snapshot separate from the projected visible book', () => {
    const offline = read('client/src/offline.ts');
    const projection = read('client/src/offline-projection.ts');
    expect(offline).toContain('projectOfflineBook(confirmed, offlineRepository.queueAll())');
    expect(offline).toContain('loadConfirmed: <T>()');
    expect(projection).toContain('const balances = {');
    expect(projection).toContain('entries: [...confirmed.entries, ...projectedEntries]');
    expect(projection).not.toContain('confirmed.balances.totalCash =');
  });

  it('uses the shared accounting engine for every projected queued entry', () => {
    const projection = read('client/src/offline-projection.ts');
    expect(projection).toContain("import { round, withLoanEffects } from '../../shared/engine'");
    expect(projection).toContain('const effects = withLoanEffects(input, confirmed);');
    expect(projection).toContain("effect.type === 'account'");
    expect(projection).toContain("effect.type === 'person'");
    expect(projection).toContain("effect.type === 'project'");
    expect(projection).toContain("effect.type === 'loan'");
  });

  it('waits for the durable queue write before claiming an offline entry was kept', () => {
    const entry = read('client/src/Entry.tsx');
    expect(entry).toContain('await outbox.add(withLink);');
    expect(entry.indexOf('await outbox.add(withLink);')).toBeLessThan(entry.indexOf("done(`Kept —"));
  });

  it('recomputes the projected React book immediately whenever the queue changes', () => {
    const app = read('client/src/App.tsx');
    expect(app).toContain('const refreshProjection = () => {');
    expect(app).toContain('const projected = snapshot.load<LoadedBook>();');
    expect(app).toContain('onQueued={refreshProjection}');
    const flush = app.slice(
      app.indexOf('const flush = async () => {'),
      app.indexOf('useEffect(() => {', app.indexOf('const flush = async () => {')),
    );
    expect(flush.match(/refreshProjection\(\);/g)?.length).toBe(2);
    expect(app).toContain('await snapshot.save(fresh);');
    expect(app).toContain('setBook(snapshot.load<LoadedBook>() ?? fresh);');
  });

  it('labels projected values and pending ledger rows as unconfirmed', () => {
    const app = read('client/src/App.tsx');
    const today = read('client/src/views/Today.tsx');
    const statement = read('client/src/views/Statement.tsx');
    expect(app).toContain('balances below are projected from the last confirmed book plus your unsynced entries');
    expect(app).toContain('balances include unsynced changes until the server confirms them');
    expect(today).toContain("'Pending sync · projected'");
    expect(statement).toContain('title="Pending sync"');
    expect(statement).toContain('not server-confirmed yet');
    expect(statement).toContain('server-confirmed matching');
  });

  it('never offers correction or void controls on projected rows', () => {
    const today = read('client/src/views/Today.tsx');
    const statement = read('client/src/views/Statement.tsx');
    expect(today).toContain('onOpen={!projected');
    const pendingStart = statement.indexOf('title="Pending sync"');
    const confirmedStart = statement.indexOf('title="Statement"');
    const pendingSection = statement.slice(pendingStart, confirmedStart);
    expect(pendingSection).not.toContain('api.correct');
    expect(pendingSection).not.toContain('api.voidEntry');
  });
});
