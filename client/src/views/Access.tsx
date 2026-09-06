import { useState, type ComponentProps } from 'react';
import { useLiveRevision } from '../live-subscription';
import AccessBase from './AccessBase';

type Props = ComponentProps<typeof AccessBase>;
type AccessSection = 'security' | 'password' | 'users' | 'add';

export default function Access(props: Props) {
  const revision = useLiveRevision(['access'], (detail) => {
    if (detail.method === 'REMOTE') return true;
    if (/^\/api\/users(?:\/|$)/.test(detail.path)) return false;
    if (/^\/api\/delegation\/users\/[^/]+\/accounts$/.test(detail.path)) return false;
    return true;
  });
  const owner = props.me.role === 'owner';
  const [section, setSection] = useState<AccessSection>('security');
  const items: Array<{ id: AccessSection; label: string; note: string }> = owner
    ? [
        { id: 'security', label: 'Security', note: 'MFA and devices' },
        { id: 'password', label: 'My password', note: 'Change your password' },
        { id: 'users', label: 'Users', note: 'Roles and account access' },
        { id: 'add', label: 'Add user', note: 'Create a login' },
      ]
    : [
        { id: 'security', label: 'Security', note: 'Devices and sign-in safety' },
        { id: 'password', label: 'My password', note: 'Change your password' },
      ];

  return (
    <div className="phase5-access-shell" data-mobile-section={section}>
      <header className="phase5-mobile-head phase5-access-mobile-head">
        <div>
          <h2>Access</h2>
          <p>{owner ? 'Manage one access area at a time.' : 'Manage your sign-in and security.'}</p>
        </div>
        <span className="chip">{owner ? 'Owner' : 'Entry only'}</span>
      </header>

      <nav className="phase5-mobile-menu phase5-access-menu" aria-label="Access sections">
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

      <AccessBase key={revision} {...props} />
    </div>
  );
}
