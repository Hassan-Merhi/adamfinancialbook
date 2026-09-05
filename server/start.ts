import { runMigrations } from './migration.js';

const applied = await runMigrations();
if (applied.length) {
  console.log(`Database schema advanced through ${applied.at(-1)}.`);
}

await import('./index.js');
