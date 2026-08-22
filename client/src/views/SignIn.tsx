/** The door. On an empty book it asks for the owner instead. */
import { useState } from 'react';
import { api, type Me } from '../api';

export default function SignIn({ needsFirstOwner, done }: {
  needsFirstOwner: boolean;
  done: (me: Me) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true); setError('');
    try {
      done(needsFirstOwner ? await api.firstOwner(email, password) : await api.login(email, password));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="door">
      <div className="card">
        <h3>{needsFirstOwner ? 'Set up your book' : 'Financial Book'}</h3>
        <div className="form" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {needsFirstOwner && (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              Nobody can open this book yet. Choose the email and password you will use.
            </p>
          )}
          <div className="f">
            <label>Email</label>
            <input type="email" autoComplete="username" value={email}
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
          </div>
          <div className="f">
            <label>Password</label>
            <input type="password" autoComplete={needsFirstOwner ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()} />
          </div>
          {error && <div className="note err" style={{ margin: 0 }}>{error}</div>}
          <button className="btn" onClick={go} disabled={busy || !email || password.length < (needsFirstOwner ? 8 : 1)}>
            {busy ? 'Opening…' : needsFirstOwner ? 'Create the book' : 'Open the book'}
          </button>
          {needsFirstOwner && <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>At least 8 characters.</p>}
        </div>
      </div>
    </div>
  );
}
