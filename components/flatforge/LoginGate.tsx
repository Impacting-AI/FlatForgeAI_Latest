'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const SESSION_KEY = 'flatforge_admin_token';
const AuthCtx = createContext<{ logout: () => void }>({ logout: () => {} });
export const useAuth = () => useContext(AuthCtx);

function getStored(): string | null {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
function setStored(t: string) { try { localStorage.setItem(SESSION_KEY, t); } catch {} }
function clearStored() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const stored = getStored();
    if (stored && stored.length >= 32) setToken(stored);
    setChecking(false);
  }, []);

  const logout = useCallback(() => {
    clearStored();
    setToken(null);
    fetch('/api/engine/auth/logout', {
      method: 'POST',
      headers: { 'x-session-token': token ?? '' },
    }).catch(() => {});
  }, [token]);

  const onLogin = useCallback((t: string) => { setStored(t); setToken(t); }, []);

  if (checking) return <Splash />;
  if (!token) return <LoginScreen onLogin={onLogin} />;
  return (
    <AuthCtx.Provider value={{ logout }}>
      {children}
      <LogoutBtn logout={logout} />
    </AuthCtx.Provider>
  );
}

function Splash() {
  return (
    <div style={S.wrap}>
      <style>{css}</style>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
        <Logo />
        <div className="ff-spin" style={{ width:22, height:22, border:'2px solid rgba(20,184,166,.25)', borderTopColor:'#14b8a6', borderRadius:'50%' }} />
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (t: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await fetch('/api/engine/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) { setError('Invalid username or password.'); return; }
      if (res.status === 503) { setError('Admin credentials not configured on server.'); return; }
      if (!res.ok) { setError('Login failed. Please try again.'); return; }
      const { token } = await res.json() as { token: string };
      onLogin(token);
    } catch { setError('Could not reach the server. Check your connection.'); }
    finally { setLoading(false); }
  }

  return (
    <div style={S.wrap}>
      <style>{css}</style>
      <div style={S.card}>
        {/* Header */}
        <div style={S.header}>
          <Logo />
          <div style={S.headerText}>
            <h1 style={S.title}>Welcome back</h1>
            <p style={S.subtitle}>Sign in to FlatForge Studio</p>
          </div>
        </div>

        <div style={S.divider} />

        {/* Form */}
        <form onSubmit={submit} style={S.form}>
          <div style={S.field}>
            <label htmlFor="ff-user" style={S.label}>Username</label>
            <input
              id="ff-user"
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              disabled={loading}
              placeholder="Enter your username"
              style={S.input}
              className="ff-input"
            />
          </div>

          <div style={S.field}>
            <label htmlFor="ff-pass" style={S.label}>Password</label>
            <div style={{ position:'relative' }}>
              <input
                id="ff-pass"
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                disabled={loading}
                placeholder="Enter your password"
                style={{ ...S.input, paddingRight:44 }}
                className="ff-input"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                style={S.eyeBtn}
                tabIndex={-1}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div style={S.error} role="alert">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink:0, marginTop:1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={S.btn} className="ff-btn">
            {loading ? (
              <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                <span className="ff-spin" style={{ width:16, height:16, border:'2px solid rgba(255,255,255,.3)', borderTopColor:'#fff', borderRadius:'50%', display:'inline-block' }} />
                Signing in…
              </span>
            ) : 'Sign in'}
          </button>
        </form>

        <p style={S.footer}>FlatForge Panel Studio · Secure workspace</p>
      </div>
    </div>
  );
}

function LogoutBtn({ logout }: { logout: () => void }) {
  return (
    <button onClick={logout} title="Sign out" aria-label="Sign out" style={S.logoutBtn} className="ff-logout">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
    </button>
  );
}

function Logo() {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
      <div style={{ width:40, height:40, borderRadius:10, background:'linear-gradient(135deg,#0d9488,#14b8a6)', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 4px 12px rgba(20,184,166,.35)' }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      </div>
      <div>
        <div style={{ fontSize:'1.1rem', fontWeight:700, letterSpacing:'-.02em', color:'var(--ff-fg,#f1f5f9)', lineHeight:1.2 }}>FlatForge</div>
        <div style={{ fontSize:'.7rem', letterSpacing:'.1em', textTransform:'uppercase', color:'#14b8a6', fontWeight:600 }}>Studio</div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--ff-bg,#0a0f0f)',
    padding: '24px 16px',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 420,
    background: 'var(--ff-card,#111918)',
    border: '1px solid var(--ff-border,rgba(20,184,166,.18))',
    borderRadius: 16,
    padding: '36px 32px 28px',
    boxShadow: '0 8px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(20,184,166,.06)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 24,
  },
  headerText: { flex: 1 },
  title: {
    margin: 0,
    fontSize: '1.35rem',
    fontWeight: 700,
    color: 'var(--ff-fg,#f1f5f9)',
    letterSpacing: '-.02em',
  },
  subtitle: {
    margin: '2px 0 0',
    fontSize: '.82rem',
    color: 'var(--ff-muted,#64748b)',
  },
  divider: {
    height: 1,
    background: 'var(--ff-border,rgba(20,184,166,.18))',
    margin: '0 0 24px',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  field: { display: 'flex', flexDirection: 'column', gap: 7 },
  label: {
    fontSize: '.82rem',
    fontWeight: 600,
    color: 'var(--ff-label,#cbd5e1)',
    letterSpacing: '.01em',
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    fontSize: '.92rem',
    background: 'var(--ff-input,#0d1515)',
    border: '1px solid var(--ff-border,rgba(20,184,166,.2))',
    borderRadius: 8,
    color: 'var(--ff-fg,#f1f5f9)',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color .15s, box-shadow .15s',
  },
  eyeBtn: {
    position: 'absolute',
    right: 12,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--ff-muted,#64748b)',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
  },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    fontSize: '.82rem',
    color: '#f87171',
    background: 'rgba(248,113,113,.08)',
    border: '1px solid rgba(248,113,113,.2)',
    borderRadius: 8,
    padding: '10px 12px',
  },
  btn: {
    width: '100%',
    padding: '11px',
    fontSize: '.95rem',
    fontWeight: 600,
    background: 'linear-gradient(135deg,#0d9488,#14b8a6)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    marginTop: 4,
    transition: 'opacity .15s, transform .1s',
    boxShadow: '0 4px 14px rgba(20,184,166,.3)',
  },
  footer: {
    margin: '20px 0 0',
    textAlign: 'center',
    fontSize: '.75rem',
    color: 'var(--ff-muted,#334155)',
  },
  logoutBtn: {
    position: 'fixed',
    bottom: 20,
    right: 20,
    zIndex: 9999,
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: '1px solid rgba(20,184,166,.25)',
    background: '#111918',
    color: '#94a3b8',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 10px rgba(0,0,0,.3)',
    transition: 'opacity .15s, background .15s',
  },
};

const css = `
  @media (prefers-color-scheme: light) {
    :root { --ff-bg:#f0fafa; --ff-card:#fff; --ff-border:rgba(13,148,136,.2); --ff-fg:#0f172a; --ff-label:#1e293b; --ff-muted:#64748b; --ff-input:#f8fffe; }
  }
  .ff-input:focus { border-color:#14b8a6 !important; box-shadow:0 0 0 3px rgba(20,184,166,.15) !important; }
  .ff-input:disabled { opacity:.5; cursor:not-allowed; }
  .ff-btn:hover:not(:disabled) { opacity:.88; transform:translateY(-1px); }
  .ff-btn:active:not(:disabled) { transform:translateY(0); }
  .ff-btn:disabled { opacity:.6; cursor:not-allowed; }
  .ff-logout:hover { background:#0d9488 !important; color:#fff !important; }
  @keyframes ff-spin { to { transform:rotate(360deg); } }
  .ff-spin { animation:ff-spin .8s linear infinite; }
  * { box-sizing:border-box; }
`;
