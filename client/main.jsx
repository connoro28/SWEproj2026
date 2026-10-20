import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

async function api(url, options = {}) {
  const isFile = options.body instanceof FormData;
  const response = await fetch(`/api${url}`, { ...options, credentials: 'same-origin',
    headers: { 'X-Stake-Request': '1', ...(!isFile && options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? (isFile ? options.body : JSON.stringify(options.body)) : undefined });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Unable to complete this request.'), { status: response.status });
  return result;
}

function Brand() { return <a className="brand" href="/" aria-label="Stake home">stake.</a>; }

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  useEffect(() => {
    api('/auth/me').then(({ user }) => setUser(user)).catch(error => {
      if (error.status !== 401) setBootError('We could not connect to Stake. Check that the server and database are running, then reload.');
    }).finally(() => setLoading(false));
  }, []);
  if (loading) return <main className="loading"><Brand /><p>Getting things ready…</p></main>;
  if (bootError) return <main className="loading"><Brand /><p role="alert">{bootError}</p><button onClick={() => location.reload()}>Try again</button></main>;
  return user ? <Dashboard user={user} setUser={setUser} /> : <Auth onAuth={setUser} />;
}

function Auth({ onAuth }) {
  const [register, setRegister] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { const result = await api(`/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: data }); onAuth(result.user); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <main className="auth-layout">
    <header className="auth-header"><Brand /><p>Goals and accountability</p></header>
    <section className="auth-panel"><div className="auth-form"><h1>{register ? 'Create an account' : 'Log in'}</h1><p className="muted">{register ? 'Save your goals and manage your stake photos.' : 'Log in to view your goals.'}</p>
      <div className="auth-tabs"><button aria-pressed={register} onClick={() => { setRegister(true); setError(''); }} disabled={busy}>Create account</button><button aria-pressed={!register} onClick={() => { setRegister(false); setError(''); }} disabled={busy}>Log in</button></div>
      <form onSubmit={submit} key={String(register)}>
        {register && <label>Your name<input name="name" autoComplete="name" placeholder="Your name" maxLength={80} required /></label>}
        <label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@example.com" maxLength={254} required /></label>
        <label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'At least 12 characters' : 'Your password'} minLength={register ? 12 : undefined} required /></label>
        {register && <p className="field-help">Use at least 12 characters</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary wide" disabled={busy}>{busy ? 'One moment…' : register ? 'Create account' : 'Log in'}</button>
      </form><p className="privacy-note">Stake photos are private to your account.</p>
    </div></section>
  </main>;
}

function Dashboard({ user, setUser }) {
  const [goals, setGoals] = useState([]);
  const [view, setView] = useState('goals');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  async function reload() {
    try { const result = await api('/goals'); setGoals(result.goals); setError(''); }
    catch (e) { if (e.status === 401) setUser(null); else setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, []);
  async function createGoal(event) {
    event.preventDefault(); setBusy(true); setError('');
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.targetDate ||= null;
    try { await api('/goals', { method: 'POST', body }); setCreating(false); setNotice('Goal saved.'); await reload(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try { await api('/auth/logout', { method: 'POST' }); setUser(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function showAdmin() {
    setError('');
    try { const result = await api('/admin/users'); setUsers(result.users); setView('admin'); }
    catch (e) { setError(e.message); }
  }
  return <div className="app-shell">
    <aside className="sidebar"><Brand /><nav><button className={view === 'goals' ? 'selected' : ''} onClick={() => setView('goals')}>My goals</button><button className={view === 'account' ? 'selected' : ''} onClick={() => setView('account')}>My account</button>{user.role === 'admin' && <button className={view === 'admin' ? 'selected' : ''} onClick={showAdmin}>Administration</button>}</nav><div className="sidebar-bottom"><div className="profile"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Administrator' : 'Member'}</small></div></div><button className="logout" onClick={logout} disabled={busy}>Log out</button></div></aside>
    <main className="workspace">
      {error && <p role="alert" className="error">{error} <button className="text-button" onClick={reload}>Retry</button></p>}
      {view === 'goals' && <><div className="page-heading"><div><h1>My goals</h1><p className="muted">Create goals and add a private stake photo.</p></div><button className="primary" onClick={() => { setCreating(!creating); setNotice(''); }}>{creating ? 'Close form' : 'New goal'}</button></div>
        <section className="summary" aria-label="Goal summary"><div><strong>{goals.length}</strong><span>Goals</span></div><div><strong>{goals.filter(g => g.stake_photo_id).length}</strong><span>With a stake photo</span></div></section>
        {notice && <p className="success" role="status">{notice}</p>}
        {creating && <section className="new-goal"><h2>New goal</h2><form onSubmit={createGoal}><label>Goal title<input name="title" maxLength={120} placeholder="e.g. Study for 30 minutes each day" required autoFocus /></label><label>Description <span className="muted">(optional)</span><textarea name="description" maxLength={1000} placeholder="Add details about your goal" rows={3} /></label><label>Target date <span className="muted">(optional)</span><input name="targetDate" type="date" /></label><div className="form-actions"><button type="button" className="secondary" onClick={() => setCreating(false)} disabled={busy}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save goal'}</button></div></form></section>}
        <div className="section-title"><h2>Saved goals</h2></div>
        {loading ? <p role="status">Loading your goals…</p> : goals.length ? <div className="goal-grid">{goals.map(goal => <GoalCard key={goal.id} goal={goal} onUploaded={reload} />)}</div> : <section className="empty"><h2>No goals yet</h2><p>Create a goal to get started.</p><button className="secondary" onClick={() => setCreating(true)}>Create your first goal</button></section>}
        <p className="build-note">Goals are saved as drafts. Check-ins and photo release are not available yet.</p></>}
      {view === 'account' && <><div className="page-heading"><div><h1>My account</h1></div></div><section className="account-card"><dl><dt>Name</dt><dd>{user.name}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Account type</dt><dd>{user.role}</dd></dl><p className="muted">Your private stake photos are visible only to you.</p></section></>}
      {view === 'admin' && <><div className="page-heading"><div><h1>Member directory</h1><p className="muted">The newest 100 accounts. Content review and account management are planned for a later version.</p></div></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>{users.map(u => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.account_status}</td></tr>)}</tbody></table></div></>}
    </main>
  </div>;
}

function GoalCard({ goal, onUploaded }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  async function upload(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(`/goals/${goal.id}/stake`, { method: 'POST', body: new FormData(event.currentTarget) }); await onUploaded(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <article className="goal-card"><div className="card-top"><span className="draft-badge">Draft</span></div><h3>{goal.title}</h3><p className="goal-description">{goal.description || 'No description added.'}</p><div className="goal-date">{goal.target_date ? `Target: ${String(goal.target_date).slice(0, 10)}` : 'No target date set'}</div><div className="stake-area">{goal.stake_photo_id ? <><div className="stake-status"><span>Private stake saved</span><button className="text-button" onClick={() => setPreview(!preview)}>{preview ? 'Hide photo' : 'View photo'}</button></div>{preview && <img className="stake-preview" src={`/api/photos/${goal.stake_photo_id}`} alt={`Your private stake for ${goal.title}`} />}</> : <form onSubmit={upload}><label className="file-label">Stake photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required /></label><p className="field-help">JPEG, PNG, or WebP · up to 5 MB / 16 megapixels</p><button className="secondary wide" disabled={busy}>{busy ? 'Uploading…' : 'Save private photo'}</button></form>}{error && <p className="error" role="alert">{error}</p>}</div></article>;
}

createRoot(document.getElementById('root')).render(<App />);
