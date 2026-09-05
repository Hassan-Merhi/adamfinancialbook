/** The door. On an empty book it asks for the owner instead. */
import { useState } from 'react';
import { ApiError, api, type Me } from '../api';
import LanguageControl from '../LanguageControl';

export default function SignIn({ needsFirstOwner, done }: {
  needsFirstOwner: boolean;
  done: (me: Me) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mfaNeeded, setMfaNeeded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true); setError('');
    try {
      done(needsFirstOwner
        ? await api.firstOwner(email, password)
        : await api.login(email, password, mfaNeeded ? totp : undefined));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'mfa_required' || e.code === 'mfa_invalid')) {
        setMfaNeeded(true);
        if (e.code === 'mfa_invalid') setTotp('');
      }
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="door">
      <div className="door-tools"><LanguageControl compact /></div>
      <div className="card">
        <h3>{needsFirstOwner ? 'Set up your book' : 'Financial Book'}</h3>
        <div className="form" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          {needsFirstOwner && (
            <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
              Nobody can open this book yet. Choose the email and password you will use.
            </p>
          )}
          <div className="f">
            <label htmlFor="book-email">Email</label>
            <input id="book-email" type="email" autoComplete="username" value={email}
              onChange={(e) => { setEmail(e.target.value); setMfaNeeded(false); setTotp(''); }}
              onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </div>
          <div className="f">
            <label htmlFor="book-password">Password</label>
            <input id="book-password" type="password" autoComplete={needsFirstOwner ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => { setPassword(e.target.value); setMfaNeeded(false); setTotp(''); }}
              onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </div>
          {!needsFirstOwner && mfaNeeded && (
            <div className="f">
              <label htmlFor="book-totp">Authenticator code</label>
              <input id="book-totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                placeholder="6-digit code" value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && totp.length === 6 && void go()} autoFocus />
            </div>
          )}
          {error && <div className="note err" style={{ margin: 0 }} role="alert">{error}</div>}
          <button className="btn" onClick={() => void go()}
            disabled={busy || !email || password.length < (needsFirstOwner ? 12 : 1) || (mfaNeeded && totp.length !== 6)}>
            {busy ? 'Opening…' : needsFirstOwner ? 'Create the book' : mfaNeeded ? 'Verify & open' : 'Open the book'}
          </button>
          {needsFirstOwner && (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              At least 12 characters. Use a mix of letters, numbers and symbols, or a long passphrase.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
