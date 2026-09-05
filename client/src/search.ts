import type { EvidenceDashboard, LoadedBook } from './api';

export type SearchView =
  | 'today' | 'money' | 'projects' | 'people' | 'attention'
  | 'report' | 'files' | 'history' | 'access' | 'setup' | 'approvals';

export type SearchAction =
  | { mode: 'view'; view: SearchView }
  | { mode: 'focus'; target: { type: 'account' | 'person' | 'project'; id: string } };

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string;
  group: 'Pages' | 'Accounts' | 'Projects' | 'People' | 'Businesses' | 'Activity' | 'Needs attention';
  action: SearchAction;
  score: number;
}

const PAGES: Array<{ view: SearchView; title: string; words: string; ownerOnly?: boolean }> = [
  { view: 'attention', title: 'Needs attention', words: 'attention pending approvals transfers receipts reminders follow up' },
  { view: 'today', title: 'Today', words: 'home dashboard today cash recent movement' },
  { view: 'money', title: 'Money', words: 'accounts balances loans cash money' },
  { view: 'projects', title: 'Projects', words: 'projects jobs sites contracts' },
  { view: 'people', title: 'People', words: 'people suppliers payroll workers staff loans' },
  { view: 'report', title: 'Day report', words: 'report day daily summary' },
  { view: 'approvals', title: 'Approvals / wallet', words: 'approvals wallet delegated transfers requests' },
  { view: 'files', title: 'Receipts & files', words: 'receipts files evidence attachments documents', ownerOnly: true },
  { view: 'history', title: 'History', words: 'history audit changes activity', ownerOnly: true },
  { view: 'access', title: 'Access', words: 'access users team permissions' },
  { view: 'setup', title: 'Setup', words: 'setup settings businesses accounts configuration', ownerOnly: true },
];

const normalize = (value: unknown) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function scoreText(query: string, ...parts: unknown[]) {
  const hay = normalize(parts.join(' '));
  if (!hay) return 0;
  if (!query) return 1;
  if (hay === query) return 120;
  if (hay.startsWith(query)) return 90;
  if (hay.includes(query)) return 65;
  const tokens = query.split(' ').filter(Boolean);
  const matched = tokens.filter((token) => hay.includes(token)).length;
  if (!matched) return 0;
  return matched === tokens.length ? 45 + matched : matched * 10;
}

function push(hits: SearchHit[], hit: Omit<SearchHit, 'score'>, score: number) {
  if (score > 0) hits.push({ ...hit, score });
}

function money(n: number | undefined) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Build a local, instant index from the already-loaded book and delegation state. */
export function searchEverything(
  rawQuery: string,
  book: LoadedBook,
  dashboard: EvidenceDashboard | null,
  owner: boolean,
  limit = 14,
): SearchHit[] {
  const query = normalize(rawQuery);
  const hits: SearchHit[] = [];

  for (const page of PAGES) {
    if (page.ownerOnly && !owner) continue;
    const score = query
      ? scoreText(query, page.title, page.words)
      : ['attention', 'today', 'money', 'projects', 'people'].includes(page.view) ? 25 : 0;
    push(hits, {
      id: `page:${page.view}`,
      title: page.title,
      subtitle: 'Page',
      group: 'Pages',
      action: { mode: 'view', view: page.view },
    }, score);
  }

  for (const account of book.accounts) {
    const business = book.businesses.find((item) => item.id === account.businessId)?.name ?? '';
    push(hits, {
      id: `account:${account.id}`,
      title: account.name,
      subtitle: [business, money(book.balances.accounts[account.id])].filter(Boolean).join(' · '),
      group: 'Accounts',
      action: { mode: 'focus', target: { type: 'account', id: account.id } },
    }, scoreText(query, account.name, business, 'account cash balance'));
  }

  for (const project of book.projects) {
    const business = book.businesses.find((item) => item.id === project.businessId)?.name ?? '';
    push(hits, {
      id: `project:${project.id}`,
      title: project.name,
      subtitle: [project.scope, business].filter(Boolean).join(' · '),
      group: 'Projects',
      action: { mode: 'focus', target: { type: 'project', id: project.id } },
    }, scoreText(query, project.name, project.scope, business, 'project job site'));
  }

  for (const person of book.people) {
    const business = book.businesses.find((item) => item.id === person.businessId)?.name ?? '';
    push(hits, {
      id: `person:${person.id}`,
      title: person.name,
      subtitle: [person.role, business, money(book.balances.people[person.id])].filter(Boolean).join(' · '),
      group: 'People',
      action: { mode: 'focus', target: { type: 'person', id: person.id } },
    }, scoreText(query, person.name, person.role, person.kind, business));
  }

  for (const business of book.businesses) {
    push(hits, {
      id: `business:${business.id}`,
      title: business.name,
      subtitle: `Business · ${money(book.balances.businesses[business.id])}`,
      group: 'Businesses',
      action: { mode: 'view', view: 'money' },
    }, scoreText(query, business.name, 'business company cash'));
  }

  for (const entry of [...book.entries].reverse().slice(0, 180)) {
    if (entry.voided) continue;
    const account = book.accounts.find((item) => item.id === (entry.accountId ?? entry.toAccountId))?.name ?? '';
    const project = book.projects.find((item) => item.id === entry.projectId)?.name ?? '';
    const person = book.people.find((item) => item.id === entry.personId)?.name ?? '';
    const score = scoreText(query, entry.purpose, entry.raw, entry.occurredOn, entry.kind, account, project, person, entry.amount);
    if (!score) continue;
    const action: SearchAction = entry.projectId
      ? { mode: 'focus', target: { type: 'project', id: entry.projectId } }
      : entry.personId
        ? { mode: 'focus', target: { type: 'person', id: entry.personId } }
        : (entry.accountId ?? entry.toAccountId)
          ? { mode: 'focus', target: { type: 'account', id: (entry.accountId ?? entry.toAccountId)! } }
          : { mode: 'view', view: 'history' };
    push(hits, {
      id: `entry:${entry.id}`,
      title: entry.purpose || entry.raw || 'Entry',
      subtitle: [entry.occurredOn, money(entry.amount), account || project || person].filter(Boolean).join(' · '),
      group: 'Activity',
      action,
    }, score - 3);
  }

  for (const reminder of book.reminders.filter((item) => !item.settled)) {
    push(hits, {
      id: `reminder:${reminder.id}`,
      title: reminder.what,
      subtitle: ['Reminder', money(reminder.amount), reminder.note].filter(Boolean).join(' · '),
      group: 'Needs attention',
      action: { mode: 'view', view: 'attention' },
    }, scoreText(query, reminder.what, reminder.note, reminder.amount, 'reminder attention unpaid allocated'));
  }

  for (const receipt of book.receipts.filter((item) => !item.inCash)) {
    const project = book.projects.find((item) => item.id === receipt.projectId)?.name ?? 'Project receipt';
    push(hits, {
      id: `receipt:${receipt.id}`,
      title: project,
      subtitle: ['Receipt not in cash', receipt.occurredOn, money(receipt.amount)].filter(Boolean).join(' · '),
      group: 'Needs attention',
      action: { mode: 'view', view: 'attention' },
    }, scoreText(query, project, receipt.occurredOn, receipt.amount, 'receipt not in cash attention'));
  }

  if (dashboard) {
    for (const approval of dashboard.approvals.filter((item) => item.status === 'pending')) {
      push(hits, {
        id: `approval:${approval.id}`,
        title: approval.request_text,
        subtitle: [approval.requester_email, approval.account_name, money(approval.amount ?? undefined), 'Pending approval'].filter(Boolean).join(' · '),
        group: 'Needs attention',
        action: { mode: 'view', view: 'attention' },
      }, scoreText(query, approval.request_text, approval.requester_email, approval.account_name, approval.amount, 'approval pending request'));
    }

    for (const transfer of dashboard.pendingTransfers) {
      push(hits, {
        id: `transfer:${transfer.id}`,
        title: transfer.purpose || 'Pending transfer',
        subtitle: [money(transfer.amount), transfer.from_account_name, transfer.to_account_name, transfer.recipient_email, 'Pending transfer'].filter(Boolean).join(' · '),
        group: 'Needs attention',
        action: { mode: 'view', view: 'attention' },
      }, scoreText(query, transfer.purpose, transfer.amount, transfer.from_account_name, transfer.to_account_name, transfer.recipient_email, 'pending transfer handoff'));
    }

    for (const notification of dashboard.notifications.filter((item) => !item.read_at).slice(0, 30)) {
      push(hits, {
        id: `notification:${notification.id}`,
        title: notification.title,
        subtitle: notification.body || 'Unread update',
        group: 'Needs attention',
        action: { mode: 'view', view: 'attention' },
      }, scoreText(query, notification.title, notification.body, notification.type, 'notification update unread'));
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
