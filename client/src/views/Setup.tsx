import { useState, type ComponentProps } from 'react';
import SetupBase from './SetupBase';

type Props = ComponentProps<typeof SetupBase>;
type SetupSection = 'businesses' | 'accounts' | 'projects' | 'people' | 'reminders' | 'openings' | 'recovery' | 'reset';

export default function Setup(props: Props) {
  const [section, setSection] = useState<SetupSection>('businesses');
  const showOpenings = props.book.businesses.length > 1;
  const items: Array<{ id: SetupSection; label: string; note: string }> = [
    { id: 'businesses', label: 'Businesses', note: 'Organization' },
    { id: 'accounts', label: 'Accounts', note: 'Cash, bank, wallet' },
    { id: 'projects', label: 'Projects', note: 'Jobs and opening receipts' },
    { id: 'people', label: 'People', note: 'Suppliers, payroll, loans' },
    { id: 'reminders', label: 'Reminders', note: 'Promised spending' },
    ...(showOpenings ? [{ id: 'openings' as const, label: 'Opening positions', note: 'Between businesses' }] : []),
    { id: 'recovery', label: 'Backup & recovery', note: 'Health and encrypted backup' },
    { id: 'reset', label: 'Reset data', note: 'Clear or start fresh' },
  ];

  return (
    <div className="phase5-setup-shell" data-mobile-section={section}>
      <header className="phase5-mobile-head phase5-setup-mobile-head">
        <div>
          <h2>Setup</h2>
          <p>Open one setup area at a time.</p>
        </div>
        <span className="chip">{props.book.businesses.length} businesses</span>
      </header>

      <nav className="phase5-mobile-menu phase5-setup-menu" aria-label="Setup sections">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            className={section === item.id ? 'active' : ''}
            aria-pressed={section === item.id}
            onClick={() => setSection(item.id)}
          >
            <span>{item.label}</span>
            <small>{item.note}</small>
          </button>
        ))}
      </nav>

      <SetupBase {...props} />
    </div>
  );
}
