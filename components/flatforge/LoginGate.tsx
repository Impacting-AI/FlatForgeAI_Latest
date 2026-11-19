'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Layers3, LoaderCircle, LogOut, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const SESSION_KEY = 'flatforge_admin_token';
const AuthCtx = createContext<{ logout: () => void }>({ logout: () => {} });
export const useAuth = () => useContext(AuthCtx);

function parseToken(token: string): { valid: boolean } {
  // token is opaque hex; just check it exists and isn't empty
  return { valid: token.length >= 32 };
}

function getStored(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
function setStored(t: string) {
  try { localStorage.setItem(SESSION_KEY, t); } catch {}
}
function clearStored() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const [token, setToken]     = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = getStored();
    if (stored && parseToken(stored).valid) setToken(stored);
    setChecking(false);
  }, []);

  const logout = useCallback(() => {
    clearStored();
    setToken(null);
    // Best-effort server-side session removal
    fetch('/api/engine/auth/logout', {
      method: 'POST',
      headers: { 'x-session-token': token ?? '' },
    }).catch(() => {});
  }, [token]);

  const onLogin = useCallback((t: string) => {
    setStored(t);
    setToken(t);
  }, []);

  if (checking) return <Splash />;
  if (!token)   return <LoginScreen onLogin={onLogin} />;

  return (
    <AuthCtx.Provider value={{ logout }}>
      {children}
      <LogoutButton logout={logout} />
    </AuthCtx.Provider>
  );
}

/* ── Splash ───────────────────────────────────────────────────────────────── */
function Splash() {
  return (
    <div className="auth-screen">
      <Layers3 size={36} className="auth-logo" />
      <LoaderCircle size={22} className="spin auth-spinner" />
      <style>{sharedStyles}</style>
    </div>
  );
}

/* ── Login form ───────────────────────────────────────────────────────────── */
function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/engine/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) { setError('Invalid username or password.'); return; }
      if (res.status === 503) { setError('Admin credentials are not configured on the server.'); return; }
      if (!res.ok)            { setError('Login failed. Please try again.'); return; }
      const { token } = await res.json() as { token: string };
      onLogin(token);
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <style>{sharedStyles}</style>
      <div className="auth-card">
        <div className="auth-brand">
          <Layers3 size={30} />
          <span>FlatForge</span>
        </div>
        <p className="auth-subtitle">Sign in to your workspace</p>

        <form onSubmit={submit} className="auth-form">
          <div className="auth-field">
            <Label htmlFor="ff-username">Username</Label>
            <Input
              id="ff-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              disabled={loading}
              placeholder="admin"
            />
          </div>

          <div className="auth-field">
            <Label htmlFor="ff-password">Password</Label>
            <div className="auth-pw-wrap">
              <Input
                id="ff-password"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                disabled={loading}
                placeholder="••••••••"
              />
              <button
                type="button"
                className="auth-pw-toggle"
                onClick={() => setShowPw(v => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <Button type="submit" className="auth-submit" disabled={loading}>
            {loading ? <><LoaderCircle size={15} className="spin" />&nbsp;Signing in…</> : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}

/* ── Logout button ────────────────────────────────────────────────────────── */
function LogoutButton({ logout }: { logout: () => void }) {
  return (
    <button className="auth-logout" onClick={logout} title="Sign out" aria-label="Sign out">
      <LogOut size={15} />
    </button>
  );
}

/* ── Shared styles ────────────────────────────────────────────────────────── */
const sharedStyles = `
  .auth-screen {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--background, #f8f9fa);
    padding: 24px max(16px, env(safe-area-inset-left, 0px));
  }
  .auth-logo { opacity: .4; }
  .auth-spinner { opacity: .4; margin-top: 20px; }

  .auth-card {
    width: 100%;
    max-width: 360px;
    background: var(--card, #fff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 12px;
    padding: 32px 28px;
    box-shadow: 0 4px 24px rgba(0,0,0,.07);
  }
  @media (prefers-color-scheme: dark) {
    .auth-screen { background: #0f1113; }
    .auth-card   { background: #1a1d21; border-color: #2a2d33; box-shadow: 0 4px 24px rgba(0,0,0,.35); }
  }

  .auth-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -.02em;
    margin-bottom: 4px;
  }
  .auth-subtitle {
    font-size: .85rem;
    opacity: .55;
    margin: 0 0 24px;
  }
  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .auth-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .auth-pw-wrap {
    position: relative;
  }
  .auth-pw-wrap input { padding-right: 36px; }
  .auth-pw-toggle {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    opacity: .5;
    color: inherit;
    line-height: 1;
  }
  .auth-pw-toggle:hover { opacity: .85; }
  .auth-error {
    font-size: .82rem;
    color: #d9534f;
    background: rgba(217,83,79,.08);
    border: 1px solid rgba(217,83,79,.22);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 0;
  }
  .auth-submit { width: 100%; margin-top: 4px; }

  .auth-logout {
    position: fixed;
    bottom: max(20px, env(safe-area-inset-bottom, 0px));
    right: max(20px, env(safe-area-inset-right, 0px));
    z-index: 9999;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--border, #e5e7eb);
    background: var(--card, #fff);
    color: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: .45;
    transition: opacity .15s;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  .auth-logout:hover { opacity: 1; }
  @media (prefers-color-scheme: dark) {
    .auth-logout { background: #1a1d21; border-color: #2a2d33; }
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin .9s linear infinite; }
`;
