import type { Catalog } from './types.js';

export type PromptView =
  | 'today'
  | 'money'
  | 'projects'
  | 'people'
  | 'report'
  | 'files'
  | 'history'
  | 'access'
  | 'setup'
  | 'approvals'
  | 'more';

export type PromptAction =
  | { mode: 'view'; view: PromptView; label: string }
  | { mode: 'focus'; target: { type: 'account' | 'person' | 'project'; id: string }; label: string };

const PREFIX = /^(?:please\s+)?(?:show(?:\s+me)?|open|go\s+to|take\s+me\s+to|view|see)\s+/i;

const PAGE_ALIASES: Array<{ view: PromptView; label: string; aliases: string[] }> = [
  { view: 'today', label: 'Today', aliases: ['today', 'home', 'dashboard'] },
  { view: 'money', label: 'Money', aliases: ['money', 'accounts', 'account balances', 'balances', 'loans'] },
  { view: 'projects', label: 'Projects', aliases: ['projects', 'jobs'] },
  { view: 'people', label: 'People', aliases: ['people', 'suppliers', 'payroll', 'workers'] },
  { view: 'report', label: 'Day report', aliases: ['report', 'day report', 'today report', "today's report"] },
  { view: 'files', label: 'Receipts & files', aliases: ['files', 'receipts', 'receipts and files', 'receipts & files'] },
  { view: 'history', label: 'History', aliases: ['history', 'audit', 'activity history'] },
  { view: 'access', label: 'Access', aliases: ['access', 'users', 'team', 'access control'] },
  { view: 'setup', label: 'Setup', aliases: ['setup', 'set up', 'settings'] },
  { view: 'approvals', label: 'Approvals', aliases: ['approvals', 'approval requests', 'requests', 'wallet', 'my wallet'] },
  { view: 'more', label: 'More', aliases: ['more', 'menu', 'more menu'] },
];

const normalize = (value: string) => value
  .toLowerCase()
  .replace(/[’]/g, "'")
  .replace(/[^a-z0-9'& ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function pageFor(target: string) {
  return PAGE_ALIASES.find((page) => page.aliases.some((alias) => normalize(alias) === target)) ?? null;
}

/**
 * Reads only safe, non-posting prompt actions. Transactions and setup commands
 * deliberately fall through to the ordinary reader and confirmation card.
 */
export function readPromptAction(text: string, catalog: Catalog): PromptAction | null {
  const raw = text.trim();
  if (!raw) return null;

  const prefixed = PREFIX.test(raw);
  const target = normalize(prefixed ? raw.replace(PREFIX, '') : raw);
  if (!target) return null;

  // Bare commands are allowed only when they are an exact page alias. This
  // avoids treating ordinary transaction language as navigation.
  const page = pageFor(target);
  if (page) return { mode: 'view', view: page.view, label: page.label };
  if (!prefixed) return null;

  const entityTarget = target.replace(/^(?:the\s+)?(?:account|project|person|supplier|employee|worker)\s+/, '');

  const candidates = [
    ...catalog.accounts.map((item) => ({ type: 'account' as const, id: item.id, name: item.name })),
    ...catalog.people.map((item) => ({ type: 'person' as const, id: item.id, name: item.name })),
    ...catalog.projects.map((item) => ({ type: 'project' as const, id: item.id, name: item.name })),
  ];

  const exact = candidates.find((item) => normalize(item.name) === entityTarget);
  if (exact) return { mode: 'focus', target: { type: exact.type, id: exact.id }, label: exact.name };

  // A business name should beat a partial account name (for example,
  // "Construction" should open Money rather than guessing "Construction Cash").
  const business = catalog.businesses.find((item) => normalize(item.name) === entityTarget);
  if (business) return { mode: 'view', view: 'money', label: `${business.name} money` };

  // A short everyday nickname is useful only when it identifies exactly one
  // thing. Ambiguous words such as "cash" intentionally fall through.
  if (entityTarget.length >= 3) {
    const partial = candidates.filter((item) => {
      const name = normalize(item.name);
      return name.startsWith(`${entityTarget} `) || name === entityTarget;
    });
    if (partial.length === 1) {
      const item = partial[0];
      return { mode: 'focus', target: { type: item.type, id: item.id }, label: item.name };
    }
  }

  return null;
}
