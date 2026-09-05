/** The door. On an empty book it asks for the owner instead. */
import { useState } from 'react';
import { api, type Me } from '../api';
import LanguageControl from '../LanguageControl';
import '../admin-mobile.css';

export default function SignIn({ needsFirstOwner, done }: {
  needsFirstOwner: boolean;
  done: (me: Me) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true); setError('');
    try {
      done(needsFirstOwner ? await api.firstOwner(username, password) : await api.login(username, password));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="door phase4-door">
      <div className="door-tools"><LanguageControl compact /></div>
      <div className="card door-card">
        <div className="door-heading">
          <span className="door-mark">FB</span>
          <div>
            <h3>{needsFirstOwner ? 'Set up your book' : 'Financial Book'}</h3>
            <p>{needsFirstOwner ? 'Create the first owner account.' : 'Sign in to continue.'}</p>
          </div>
        </div>
        <div className="form door-form">
          {needsFirstOwner && (
            <p className="muted door-help">
              Choose a username and password. Usernames ignore spaces and capital letters when signing in.
            </p>
          )}
          <div className="f">
            <label htmlFor="book-username">Username</label>
            <input id="book-username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
              value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="Hassan Dakik" onKeyDown={(e) => e.key === 'Enter' && void go()} />
            <small className="field-help">Spaces and uppercase/lowercase do not matter.</small>
          </div>
          <div className="f">
            <label htmlFor="book-password">Password</label>
            <div className="password-field">
              <input id="book-password" type={showPassword ? 'text' : 'password'}
                autoComplete={needsFirstOwner ? 'new-password' : 'current-password'}
                value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void go()} />
              <button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          {error && <div className="note err door-error" role="alert">{error}</div>}
          <button className="btn door-submit" onClick={() => void go()}
            disabled={busy || !username.trim() || password.length < (needsFirstOwner ? 8 : 1)}>
            {busy ? 'Opening…' : needsFirstOwner ? 'Create the book' : 'Sign in'}
          </button>
          {needsFirstOwner && <p className="muted door-footnote">Password must be at least 8 characters.</p>}
        </div>
      </div>
    </div>
  );
}
