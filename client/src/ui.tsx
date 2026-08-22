/** The small pieces every screen is built from. */
import type { ReactNode } from 'react';

/** Minus means you owe it. Plus means it is owed to you. */
export const money = (v: number) =>
  (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const signed = (v: number) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const tone = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function shortDate(iso: string): string {
  if (!iso) return 'date unknown';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

export function longDate(iso: string): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  return `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

export function shiftDay(iso: string, days: number): string {
  const dt = new Date(`${iso}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

export const KINDS: Record<string, string> = {
  expense: 'Expense',
  credit_purchase: 'On credit',
  receipt: 'Receipt',
  transfer: 'Transfer',
  person_loan: 'Loan out',
  salary: 'Salary',
  supplier_payment: 'Supplier paid',
};

export function Card({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {title && <h3>{title}{aside && <span className="muted">{aside}</span>}</h3>}
      {children}
    </div>
  );
}

/** One line of the book: a name on the left, a figure on the right. */
export function Row({ title, sub, value, valueTone, valueSub, onOpen }: {
  title: ReactNode; sub?: ReactNode; value?: ReactNode;
  valueTone?: string; valueSub?: ReactNode; onOpen?: () => void;
}) {
  const inner = (
    <>
      <span className="main">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      {value !== undefined && (
        <span className={`val num ${valueTone ?? ''}`}>
          {value}
          {valueSub && <small>{valueSub}</small>}
        </span>
      )}
      {onOpen && <span className="chev">›</span>}
    </>
  );
  return onOpen
    ? <button className="row link" onClick={onOpen}>{inner}</button>
    : <div className="row">{inner}</div>;
}

export function Tile({ label, value, note, tone: t, wide }: {
  label: string; value: string; note?: string; tone?: string; wide?: boolean;
}) {
  return (
    <div className={`tile${wide ? ' wide' : ''}`}>
      <span className="lab">{label}</span>
      <span className={`v num ${t ?? ''}`}>{value}</span>
      {note && <span className="note-sm">{note}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="row muted" style={{ fontSize: 13.5 }}>{children}</div>;
}
