import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowLeft, ArrowRight, Ban, Check, CheckCircle2, CircleHelp,
  Clipboard, Clock3, Copy, Crown, ExternalLink, Eye, EyeOff, Gauge, Gem, Globe2, KeyRound,
  LayoutDashboard, Link2, LogOut, Menu, MoreHorizontal, Plus, RefreshCw, Search, Shield,
  ShieldCheck, Skull, Sparkles, User, UserCheck, UserPlus, Users, Wallet, X, Zap, History as HistoryIcon
} from 'lucide-react';

type Role = 'admin' | 'moderator' | 'invite_manager' | 'user';
type User = { id: number; username: string; role: Role };
type Page = 'overview' | 'matches' | 'steam' | 'history' | 'settings' | 'admin' | 'invites';
type Job = {
  id: string; kind: 'match' | 'steam'; title: string; status: string; progress: number;
  total: number; rows: { profile: string; price: number | null; status: string }[]; logs: string[]; done: boolean; historyId?: number;
};
type HistoryItem = {
  id: number; user_id: number; username: string; kind: 'match' | 'steam'; title: string; status: string;
  total: number; progress: number; rows: { profile: string; price: number | null; status: string }[];
  logs?: string[]; created_at: string;
};
type AdminUser = {
  id: number; username: string; role: Role; active: number; banned: number;
  ban_reason: string | null; created_at: string;
};
type Invite = {
  id: number; code_hint: string; max_uses: number; uses: number; expires_at: number;
  revoked_at: number | null; created_at: string; created_by?: string; status: string;
};
type WeeklyInviteQuota = { limit: number; used: number; remaining: number; week_start: string; resets_at: number };

const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  let data: any = {};
  try { data = await response.json(); } catch { /* no JSON body */ }
  if (!response.ok) throw new Error(data.error || `Ошибка HTTP ${response.status}`);
  return data as T;
};

function money(value: number | null): string { return value === null ? '—' : `$${value.toFixed(2)}`; }
function uidLabel(id: number): string { return `UID ${String(id).padStart(5, '0')}`; }
function roleLabel(role: Role): string { return ({ admin: 'Администратор', moderator: 'Модератор', invite_manager: 'Генератор инвайтов', user: 'Участник' })[role]; }
function dateTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function dateLabel(value: string | number): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'ok' | 'error' } | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [memberInvites, setMemberInvites] = useState<Invite[]>([]);
  const [weeklyInviteQuota, setWeeklyInviteQuota] = useState<WeeklyInviteQuota | null>(null);
  const [adminTab, setAdminTab] = useState<'users' | 'invites'>('invites');
  const [newInvite, setNewInvite] = useState<{ code: string; uses: number; expires: number } | null>(null);
  const [inviteUses, setInviteUses] = useState('1');
  const [inviteDays, setInviteDays] = useState('7');
  const [credential, setCredential] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matchId, setMatchId] = useState('');
  const [onlyOne, setOnlyOne] = useState(true);
  const [only120, setOnly120] = useState(false);
  const [steamLink, setSteamLink] = useState('');
  const [matchJob, setMatchJob] = useState<Job | null>(null);
  const [steamJob, setSteamJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyScope, setHistoryScope] = useState<'mine' | 'all'>('mine');

  const notify = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const loadHistory = useCallback(async (scope: 'mine' | 'all') => {
    try { setHistory(await api<HistoryItem[]>(scope === 'all' ? '/api/admin/history' : '/api/history')); }
    catch (error) { notify((error as Error).message, 'error'); }
  }, [notify]);

  const loadMe = useCallback(async () => {
    try {
      const current = await api<User>('/api/auth/me');
      setUser(current);
    } catch { setUser(null); }
    finally { setLoadingAuth(false); }
  }, []);

  useEffect(() => { void loadMe(); }, [loadMe]);
  useEffect(() => {
    if (user?.role === 'admin' || user?.role === 'moderator') void loadAdminData();
    if (user?.role === 'invite_manager') void loadMemberInviteData();
  }, [user]);

  async function loadAdminData() {
    if (!user || (user.role !== 'admin' && user.role !== 'moderator')) return;
    try {
      const userRows = await api<AdminUser[]>('/api/admin/users');
      setUsers(userRows);
      if (user.role === 'admin') setInvites(await api<Invite[]>('/api/admin/invites'));
      else setInvites([]);
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  async function loadMemberInviteData() {
    try {
      const result = await api<{ quota: WeeklyInviteQuota; invites: Invite[] }>('/api/member/invites');
      setWeeklyInviteQuota(result.quota); setMemberInvites(result.invites);
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    const invite_code = String(form.get('invite_code') || '').trim();
    setBusy(true);
    try {
      const result = await api<{ user: User }>(authMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
        method: 'POST', body: JSON.stringify(authMode === 'login' ? { username, password } : { username, password, invite_code })
      });
      setUser(result.user); setPage('overview'); notify(authMode === 'login' ? 'Добро пожаловать' : 'Аккаунт успешно создан');
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* cookie may already be expired */ }
    setUser(null); setAuthMode('login'); setPage('overview'); setMatchJob(null); setSteamJob(null); setNewInvite(null); setCredential(null); setHistory([]); setHistoryScope('mine'); setMemberInvites([]); setWeeklyInviteQuota(null);
  }

  async function startMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMatchJob(null);
    try {
      const result = await api<Job>('/api/check/match', {
        method: 'POST', body: JSON.stringify({ match_id: matchId, only_over_one: onlyOne, only_over_120: only120 })
      });
      setMatchJob(result);
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function startSteam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setSteamJob(null);
    try {
      const result = await api<Job>('/api/check/steam', { method: 'POST', body: JSON.stringify({ link: steamLink }) });
      setSteamJob(result);
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNewInvite(null);
    try {
      const result = await api<{ id: number; code: string; max_uses: number; expires_at: number }>('/api/admin/invites', {
        method: 'POST', body: JSON.stringify({ max_uses: Number(inviteUses), expires_days: Number(inviteDays) })
      });
      setNewInvite({ code: result.code, uses: result.max_uses, expires: result.expires_at });
      notify('Инвайт создан. Скопируй ключ — повторно он не показывается.'); await loadAdminData();
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function createMemberInvite() {
    setBusy(true); setNewInvite(null);
    try {
      const result = await api<{ id: number; code: string; max_uses: number; expires_at: number; quota: WeeklyInviteQuota }>('/api/member/invites', { method: 'POST' });
      setNewInvite({ code: result.code, uses: result.max_uses, expires: result.expires_at });
      setWeeklyInviteQuota(result.quota);
      notify('Инвайт создан. Он действует 7 дней и подходит для одной регистрации.');
      await loadMemberInviteData();
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function revokeInvite(id: number) {
    if (!window.confirm('Отозвать этот инвайт? Неиспользованные регистрации по нему станут невозможны.')) return;
    try { await api(`/api/admin/invites/${id}/revoke`, { method: 'POST' }); notify('Инвайт отозван'); await loadAdminData(); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function banUser(target: AdminUser) {
    const reason = window.prompt(`Причина блокировки пользователя ${target.username}:`, 'Нарушение правил');
    if (reason === null) return;
    if (!window.confirm(`Заблокировать ${target.username}? Все его активные сессии будут завершены.`)) return;
    try { await api(`/api/admin/users/${target.id}/ban`, { method: 'POST', body: JSON.stringify({ reason }) }); notify(`${target.username} заблокирован`); await loadAdminData(); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function unbanUser(target: AdminUser) {
    if (!window.confirm(`Разблокировать ${target.username}?`)) return;
    try { await api(`/api/admin/users/${target.id}/unban`, { method: 'POST' }); notify(`${target.username} разблокирован`); await loadAdminData(); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function toggleUser(target: AdminUser) {
    try { await api(`/api/admin/users/${target.id}/toggle`, { method: 'POST' }); notify('Доступ пользователя обновлён'); await loadAdminData(); }
    catch (error) { notify((error as Error).message, 'error'); }
  }

  async function resetPassword(target: AdminUser) {
    if (!window.confirm(`Сбросить пароль пользователя ${target.username}?`)) return;
    try {
      const result = await api<{ temporary_password: string }>(`/api/admin/users/${target.id}/reset-password`, { method: 'POST' });
      setCredential(`Логин: ${target.username}\nНовый пароль: ${result.temporary_password}`);
      notify('Пароль сброшен. Старые сессии закрыты.');
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  async function changeUserRole(target: AdminUser, role: Role) {
    if (!window.confirm(`Изменить роль ${target.username} на «${roleLabel(role)}»?`)) return;
    try {
      await api(`/api/admin/users/${target.id}/role`, { method: 'POST', body: JSON.stringify({ role }) });
      notify(`Роль пользователя ${target.username} обновлена. Новые права появятся после обновления страницы.`);
      await loadAdminData();
    } catch (error) { notify((error as Error).message, 'error'); }
  }

  const pageTitle = useMemo(() => ({ overview: 'Обзор', matches: 'Проверка матчей', steam: 'Проверка Steam-профиля', history: 'История проверок', settings: 'Мои API-ключи', admin: user?.role === 'moderator' ? 'Модерация' : 'Управление доступом', invites: 'Генератор инвайтов' }[page]), [page, user?.role]);
  const navigate = (target: Page) => { setPage(target); setMobileOpen(false); if (target === 'admin') { if (user?.role === 'moderator') setAdminTab('users'); void loadAdminData(); } if (target === 'invites') void loadMemberInviteData(); if (target === 'history') void loadHistory(historyScope); };

  if (loadingAuth) return <div className="boot-screen"><div className="boot-mark"><img src="/assets/makerow-dog.png"/><span /></div><p>MAKEROW TEAMWORK</p><small>Подключаем защищённую панель…</small></div>;

  if (!user) return <AuthScreen mode={authMode} setMode={setAuthMode} onSubmit={submitAuth} busy={busy} toast={toast} />;

  const isAdmin = user.role === 'admin';
  const isModerator = user.role === 'moderator';
  const isInviteManager = user.role === 'invite_manager';
  const canModerate = isAdmin || isModerator;
  return (
    <div className="app-frame">
      <div className={`mobile-scrim ${mobileOpen ? 'show' : ''}`} onClick={() => setMobileOpen(false)} />
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-block">
          <div className="brand-logo"><img src="/assets/makerow-dog.png" alt="MAKEROW" /></div>
          <div className="brand-copy"><strong>MAKEROW</strong><span>TEAMWORK</span></div>
          <button className="mobile-close icon-button" onClick={() => setMobileOpen(false)} aria-label="Закрыть меню"><X size={18}/></button>
        </div>
        <div className="workspace-chip"><span className="workspace-dot"/> PRIVATE WORKSPACE <span className="workspace-caret">⌄</span></div>
        <div className="nav-label">РАБОЧАЯ ОБЛАСТЬ</div>
        <nav className="side-nav">
          <NavButton active={page === 'overview'} icon={<LayoutDashboard size={17}/>} label="Обзор" onClick={() => navigate('overview')}/>
          <NavButton active={page === 'matches'} icon={<Activity size={17}/>} label="Проверка матчей" onClick={() => navigate('matches')}/>
          <NavButton active={page === 'steam'} icon={<Link2 size={17}/>} label="Steam-профиль" onClick={() => navigate('steam')}/>
          <NavButton active={page === 'history'} icon={<HistoryIcon size={17}/>} label="История проверок" onClick={() => navigate('history')}/>
          <NavButton active={page === 'settings'} icon={<KeyRound size={17}/>} label="Мои API-ключи" onClick={() => navigate('settings')}/>
        </nav>
        {canModerate && <>
          <div className="nav-label admin-label">{isAdmin ? 'АДМИНИСТРИРОВАНИЕ' : 'МОДЕРАЦИЯ'}</div>
          <nav className="side-nav"><NavButton active={page === 'admin'} icon={<Shield size={17}/>} label={isAdmin ? 'Панель управления' : 'Модерация участников'} onClick={() => navigate('admin')} badge={isAdmin ? 'ADMIN' : 'MOD'}/></nav>
        </>}
        {isInviteManager && <>
          <div className="nav-label admin-label">ДОСТУПЫ</div>
          <nav className="side-nav"><NavButton active={page === 'invites'} icon={<KeyRound size={17}/>} label="Генератор инвайтов" onClick={() => navigate('invites')} badge="3 / НЕД."/></nav>
        </>}
        <div className="sidebar-bottom">
          <div className="system-status"><span className="pulse-dot"/><span>Система активна</span><span className="status-right">LIVE</span></div>
          <div className="profile-mini">
            <div className="profile-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
            <div className="profile-meta"><strong>{user.username}</strong><span>{uidLabel(user.id)} · {roleLabel(user.role)}</span></div>
            {isAdmin && <Crown size={14} className="crown-icon"/>}{isModerator && <Shield size={14} className="crown-icon"/>}{isInviteManager && <KeyRound size={14} className="crown-icon"/>}
            <button className="icon-button logout-mini" title="Выйти" onClick={logout}><LogOut size={16}/></button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileOpen(true)}><Menu size={19}/></button><div><div className="breadcrumb">MAKEROW <span>/</span> {pageTitle.toUpperCase()}</div><h1>{pageTitle}</h1></div></div>
          <div className="topbar-right"><div className="secure-indicator"><ShieldCheck size={15}/><span>Защищённое соединение</span></div><div className="top-avatar">{user.username.slice(0, 1).toUpperCase()}</div></div>
        </header>

        {page === 'overview' && <Overview user={user} navigate={navigate} usersCount={users.length} />}
        {page === 'matches' && <Matches matchId={matchId} setMatchId={setMatchId} onlyOne={onlyOne} setOnlyOne={setOnlyOne} only120={only120} setOnly120={setOnly120} busy={busy} job={matchJob} onSubmit={startMatch}/>} 
        {page === 'steam' && <Steam link={steamLink} setLink={setSteamLink} busy={busy} job={steamJob} onSubmit={startSteam}/>} 
        {page === 'history' && <HistoryPage items={history} isAdmin={isAdmin} scope={historyScope} setScope={(scope) => { setHistoryScope(scope); void loadHistory(scope); }} refresh={() => loadHistory(historyScope)} />}
        {page === 'settings' && <ApiKeysPage notify={notify} />}
        {page === 'admin' && canModerate && <AdminPanel
          mode={isAdmin ? 'admin' : 'moderator'} currentUserId={user.id}
          tab={adminTab} setTab={setAdminTab} users={users} invites={invites} busy={busy}
          uses={inviteUses} setUses={setInviteUses} days={inviteDays} setDays={setInviteDays}
          newInvite={newInvite} setNewInvite={setNewInvite} credential={credential} setCredential={setCredential}
          createInvite={createInvite} revokeInvite={revokeInvite} banUser={banUser} unbanUser={unbanUser}
          toggleUser={toggleUser} resetPassword={resetPassword} changeUserRole={changeUserRole} refresh={loadAdminData}
        />}
        {page === 'invites' && isInviteManager && <InviteManagerPanel quota={weeklyInviteQuota} invites={memberInvites} newInvite={newInvite} setNewInvite={setNewInvite} busy={busy} createInvite={createMemberInvite} refresh={loadMemberInviteData}/>}
        <footer className="page-footer"><span>MAKEROW TEAMWORK <i>© {new Date().getFullYear()}</i></span><span>STRATZ <b>·</b> LZT MARKET <b>·</b> PRIVATE ACCESS</span></footer>
      </main>
      {toast && <div className={`toast ${toast.kind}`}><span className="toast-icon">{toast.kind === 'ok' ? <CheckCircle2 size={17}/> : <CircleHelp size={17}/>}</span>{toast.message}<button onClick={() => setToast(null)}><X size={15}/></button></div>}
    </div>
  );
}

function NavButton({ active, icon, label, onClick, badge }: { active: boolean; icon: ReactNode; label: string; onClick: () => void; badge?: string }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{badge && <small>{badge}</small>}{active && <span className="nav-active-bar"/>}</button>;
}

function AuthScreen({ mode, setMode, onSubmit, busy, toast }: { mode: 'login' | 'register'; setMode: (mode: 'login' | 'register') => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; toast: { message: string; kind: 'ok' | 'error' } | null }) {
  const [showPassword, setShowPassword] = useState(false);
  return <div className="auth-layout">
    <div className="auth-atmosphere"/>
    <div className="auth-left">
      <div className="auth-brand"><img src="/assets/makerow-dog.png"/><div><b>MAKEROW</b><span>TEAMWORK</span></div></div>
      <div className="auth-hero"><div className="eyebrow"><span/> PRIVATE DOTA INVENTORY INTELLIGENCE</div><h1>Данные матча.<br/><em>Полная картина.</em></h1><p>Аналитика инвентарей Dota 2 в одном рабочем пространстве. Точные статусы, оценка и командные результаты.</p><div className="auth-features"><div><ShieldCheck size={16}/> Закрытый доступ</div><div><Zap size={16}/> Быстрая проверка</div><div><Users size={16}/> Командная работа</div></div></div>
      <div className="auth-bottom-line"><span>MAKEROW TEAMWORK</span><span>PRIVATE ACCESS SYSTEM · 02.0</span></div>
    </div>
    <div className="auth-right"><div className="auth-card-wrap">
      <div className="auth-card-logo"><img src="/assets/makerow-dog.png"/></div>
      <div className="auth-card-head"><div className="eyebrow">WELCOME TO THE WORKSPACE</div><h2>{mode === 'login' ? 'С возвращением' : 'Создать аккаунт'}</h2><p>{mode === 'login' ? 'Войди, чтобы продолжить работу с панелью.' : 'Регистрация доступна только по персональному инвайту.'}</p></div>
      <div className="auth-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => setMode('login')}>Войти</button><button className={mode === 'register' ? 'selected' : ''} onClick={() => setMode('register')}>Регистрация</button></div>
      <form className="auth-form" onSubmit={onSubmit}>
        {mode === 'register' && <label className="field-label">ИНВАЙТ-КЛЮЧ<div className="input-wrap"><KeyRound size={17}/><input name="invite_code" required placeholder="MW-XXXX-XXXX-XXXX" autoComplete="off"/></div><small>Ключ выдаёт администратор команды.</small></label>}
        <label className="field-label">ЛОГИН<div className="input-wrap"><User size={17}/><input name="username" required minLength={3} maxLength={32} placeholder="Твой логин" autoComplete="username"/></div></label>
        <label className="field-label">ПАРОЛЬ<div className="input-wrap"><KeyRound size={17}/><input name="password" type={showPassword ? 'text' : 'password'} required minLength={mode === 'register' ? 10 : 1} maxLength={128} placeholder={mode === 'register' ? 'Минимум 10 символов' : 'Твой пароль'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}/><button className="input-action" type="button" onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div></label>
        <button className="button button-primary auth-submit" disabled={busy}>{busy ? <span className="spinner"/> : mode === 'login' ? <><span>Войти в панель</span><ArrowRight size={17}/></> : <><span>Создать аккаунт</span><ArrowRight size={17}/></>}</button>
      </form>
      <div className="auth-security"><ShieldCheck size={14}/><span>Защищённая авторизация · пароли зашифрованы</span></div>
      {toast && <div className={`auth-toast ${toast.kind}`}>{toast.message}</div>}
      <div className="auth-foot">НЕТ ИНВАЙТА? <a href="https://discord.gg/CEp9XpZmZZ" target="_blank" rel="noopener noreferrer">Обратись к администратору команды</a></div>
    </div></div>
  </div>;
}

function Overview({ user, navigate, usersCount }: { user: User; navigate: (page: Page) => void; usersCount: number }) {
  return <div className="page-stack">
    <section className="welcome-banner"><div className="welcome-noise"/><div className="welcome-content"><div className="eyebrow">TEAM WORKSPACE <span className="eyebrow-line"/></div><h2>Рады видеть, <em>{user.username}</em></h2><p>Все инструменты проверки Dota 2 и Steam — в одном месте. <span className="uid-chip">{uidLabel(user.id)}</span></p><button className="button button-light" onClick={() => navigate('matches')}>Открыть проверку матча <ArrowRight size={16}/></button></div><div className="welcome-orb"><img src="/assets/makerow-dog.png"/></div><div className="banner-index">01 <i>/</i> 03</div></section>
    <div className="section-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Рабочая область</h2></div><div className="live-chip"><span/> ВСЁ СИСТЕМЫ ONLINE</div></div>
    <div className="feature-grid">
      <button className="feature-card" onClick={() => navigate('matches')}><div className="feature-top"><div className="feature-icon"><Activity size={19}/></div><ArrowDownRight size={17}/></div><div><h3>Проверка матчей</h3><p>Получи состав матча и проверь стоимость инвентарей через LZT Market.</p></div><div className="feature-foot"><span>STRATZ · LZT MARKET</span><span>ОТКРЫТЬ <ArrowRight size={13}/></span></div></button>
      <button className="feature-card" onClick={() => navigate('steam')}><div className="feature-top"><div className="feature-icon"><Link2 size={19}/></div><ArrowDownRight size={17}/></div><div><h3>Steam-профиль</h3><p>Проверь стоимость инвентаря по ссылке или SteamID64.</p></div><div className="feature-foot"><span>STEAM VALUE LOOKUP</span><span>ОТКРЫТЬ <ArrowRight size={13}/></span></div></button>
      {user.role === 'admin' ? <button className="feature-card" onClick={() => navigate('admin')}><div className="feature-top"><div className="feature-icon"><Shield size={19}/></div><ArrowDownRight size={17}/></div><div><h3>Управление доступом</h3><p>Инвайты, аккаунты, блокировки и сброс паролей участников.</p></div><div className="feature-foot"><span>{usersCount} АККАУНТОВ</span><span>ОТКРЫТЬ <ArrowRight size={13}/></span></div></button> : <div className="feature-card static"><div className="feature-top"><div className="feature-icon"><ShieldCheck size={19}/></div><span className="member-tag">MEMBER</span></div><div><h3>Закрытая команда</h3><p>Доступ к рабочему пространству предоставлен администратором.</p></div><div className="feature-foot"><span>PRIVATE ACCESS</span><span>ACTIVE <Check size={13}/></span></div></div>}
    </div>
    <div className="bottom-info-grid"><div className="info-panel"><div className="info-panel-icon"><Gauge size={18}/></div><div><b>Одна точка управления</b><p>Проверки, статусы и история текущих задач в одном интерфейсе.</p></div></div><div className="info-panel"><div className="info-panel-icon"><ShieldCheck size={18}/></div><div><b>Доступ под контролем</b><p>Аккаунты защищены паролями и серверными сессиями.</p></div></div></div>
  </div>;
}

function ApiKeysPage({ notify }: { notify: (message: string, kind?: 'ok' | 'error') => void }) {
  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ configured: boolean; updated_at: string | null }>('/api/settings/stratz');
      setConfigured(result.configured);
      setUpdatedAt(result.updated_at);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await api('/api/settings/stratz', { method: 'PUT', body: JSON.stringify({ token }) });
      setToken('');
      await refresh();
      notify('Твой STRATZ API Key сохранён и зашифрован.');
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!window.confirm('Удалить сохранённый STRATZ API Key из твоего аккаунта?')) return;
    setSaving(true);
    try {
      await api('/api/settings/stratz', { method: 'DELETE' });
      setConfigured(false); setUpdatedAt(null); setToken('');
      notify('STRATZ API Key удалён.');
    } catch (error) { notify((error as Error).message, 'error'); }
    finally { setSaving(false); }
  }

  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow">PERSONAL API SETTINGS</div><h2>Твои <em>API-ключи</em></h2><p>Каждый участник добавляет собственный ключ STRATZ. Он используется только для проверок, запущенных из этого аккаунта.</p></div><div className="intro-stamp"><KeyRound size={22}/><span>PRIVATE<br/>CREDENTIALS</span></div></div>
    <section className="surface-card api-key-card">
      <div className="card-overline"><span>01 / STRATZ GRAPHQL</span><span className={`tag ${configured ? '' : 'muted-tag'}`}>{loading ? 'ПРОВЕРКА…' : configured ? 'КЛЮЧ СОХРАНЁН' : 'КЛЮЧ НЕ ДОБАВЛЕН'}</span></div>
      <div className="api-key-heading"><div className="big-card-icon"><KeyRound size={20}/></div><div><h3>Личный STRATZ API Key</h3><p>{configured ? 'Ключ уже сохранён для этого аккаунта.' : 'Вставь собственный ключ, чтобы запускать проверку матчей.'}</p></div></div>
      <form className="api-key-form" onSubmit={save}>
        <label className="field-label">STRATZ API KEY<div className="input-wrap"><KeyRound size={17}/><input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={configured ? 'Вставь новый ключ, чтобы заменить текущий' : 'Вставь свой STRATZ API Key'} autoComplete="new-password" minLength={20} maxLength={4096}/></div><small>Получи ключ в личном кабинете STRATZ. Не отправляй его в чат и не публикуй в GitHub.</small></label>
        <div className="api-key-actions"><button className="button button-primary" disabled={saving || loading || token.trim().length < 20}>{saving ? <><span className="spinner"/> Сохраняем…</> : configured ? 'Заменить API Key' : 'Сохранить API Key'}</button>{configured && <button type="button" className="table-action danger" disabled={saving} onClick={() => void remove()}><X size={14}/> Удалить ключ</button>}</div>
      </form>
      {configured && updatedAt && <div className="api-key-status"><ShieldCheck size={15}/><span>Ключ сохранён {new Date(updatedAt).toLocaleString('ru-RU')}</span></div>}
    </section>
    <section className="surface-card api-key-info"><div className="card-overline"><span>ВАЖНО О БЕЗОПАСНОСТИ</span><span className="tag">AES-256-GCM</span></div><p>STRATZ API Key шифруется на сервере перед записью в Neon. В интерфейс ключ обратно не передаётся. У каждого аккаунта свой отдельный ключ; администратор не может просмотреть ключи участников.</p><a href="https://stratz.com/" target="_blank" rel="noreferrer">Открыть STRATZ <ExternalLink size={13}/></a></section>
  </div>;
}

function Matches({ matchId, setMatchId, onlyOne, setOnlyOne, only120, setOnly120, busy, job, onSubmit }: { matchId: string; setMatchId: (v: string) => void; onlyOne: boolean; setOnlyOne: (v: boolean) => void; only120: boolean; setOnly120: (v: boolean) => void; busy: boolean; job: Job | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">MATCH SCANNER <span className="tiny-status">● READY</span></div><h2>Сканирование <em>матча</em></h2><p>Используем твой персональный STRATZ API Key, затем запрашиваем оценку каждого инвентаря через LZT Market.</p></div><div className="intro-stamp"><Activity size={22}/><span>DOTA 2<br/>ANALYTICS</span></div></div>
    <div className="scanner-grid"><form className="surface-card scan-form" onSubmit={onSubmit}><div className="card-overline"><span>01 / INPUT</span><span className="tag">MATCH ID</span></div><h3>Параметры проверки</h3><label className="field-label">ID МАТЧА ИЛИ ССЫЛКА<div className="input-wrap"><Search size={17}/><input required value={matchId} onChange={e => setMatchId(e.target.value)} placeholder="Например, 9099439391"/></div></label><div className="filter-heading"><span>ФИЛЬТР СТОИМОСТИ</span><small>USD · DOTA 2</small></div><ToggleRow checked={onlyOne} onChange={setOnlyOne} title="Инвентари от $1" subtitle="Показывать стоимость от одного доллара"/><ToggleRow checked={only120} onChange={setOnly120} title="Инвентари от $120" subtitle="Только дорогие инвентари от 120 USD"/><div className="filter-note"><CircleHelp size={14}/><span>Если включены оба фильтра, применяется порог $120. Если оба выключены — отображаются все оценки.</span></div><button className="button button-primary submit-wide" disabled={busy}>{busy ? <><span className="spinner"/> Проверяем…</> : <>Запустить сканирование <ArrowRight size={17}/></>}</button></form>
      <div className="surface-card scan-aside"><div className="card-overline"><span>02 / PIPELINE</span><span className="tag muted-tag">LIVE FLOW</span></div><h3>Этапы обработки</h3><PipelineStep no="01" title="STRATZ API" text="Получаем участников матча и SteamID, если они доступны."/><PipelineStep no="02" title="LZT MARKET" text="Запрашиваем оценку Dota 2 через steam-value. Steam API не используется."/><PipelineStep no="03" title="Результаты и Discord" text="Обновляем статусы, выводим цены и отправляем итог в Discord." last/><div className="aside-foot"><ShieldCheck size={15}/> STRATZ-ключ каждого участника хранится отдельно в зашифрованном виде.</div></div></div>
    {job && <JobPanel job={job} title="Результаты матча"/>}
  </div>;
}
function ToggleRow({ checked, onChange, title, subtitle }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle: string }) {
  return <button type="button" className={`toggle-row ${checked ? 'checked' : ''}`} onClick={() => onChange(!checked)}><span className="custom-check">{checked && <Check size={13}/>}</span><span className="toggle-copy"><b>{title}</b><small>{subtitle}</small></span><span className={`switch ${checked ? 'on' : ''}`}><i/></span></button>;
}
function PipelineStep({ no, title, text, last }: { no: string; title: string; text: string; last?: boolean }) {
  return <div className={`pipeline-step ${last ? 'last' : ''}`}><div className="pipeline-no">{no}</div><div><b>{title}</b><p>{text}</p></div></div>;
}
function Steam({ link, setLink, busy, job, onSubmit }: { link: string; setLink: (v: string) => void; busy: boolean; job: Job | null; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">STEAM VALUE LOOKUP</div><h2>Проверка <em>профиля</em></h2><p>Вставь публичную Steam-ссылку или SteamID64. Стоимость инвентаря запрашивается через LZT Market.</p></div><div className="intro-stamp"><Wallet size={22}/><span>INVENTORY<br/>VALUE</span></div></div><div className="surface-card steam-card"><div className="card-overline"><span>PROFILE LOOKUP</span><span className="tag">LZT MARKET</span></div><h3>Введи ссылку на Steam-профиль</h3><form className="steam-form" onSubmit={onSubmit}><label className="field-label">STEAM PROFILE URL<div className="input-wrap"><Link2 size={17}/><input required value={link} onChange={e => setLink(e.target.value)} placeholder="https://steamcommunity.com/id/... или SteamID64"/></div></label><button className="button button-primary" disabled={busy}>{busy ? <><span className="spinner"/> Проверяем…</> : <>Оценить инвентарь <ArrowRight size={17}/></>}</button></form><div className="steam-help"><ShieldCheck size={15}/><span>Чекер не обращается к Steam — оценка выполняется через LZT Market API.</span></div></div>{job && <JobPanel job={job} title="Результат проверки профиля"/>}</div>;
}
function JobPanel({ job, title, archive }: { job: Job; title: string; archive?: boolean }) {
  const percent = job.total ? Math.min(100, job.progress / job.total * 100) : 0;
  return <section className="surface-card job-panel"><div className="job-head"><div><div className="card-overline"><span>{archive ? 'ARCHIVE' : 'LIVE CHECK'}</span><span className="job-id">{archive ? `#${job.id}` : `ID ${job.id.slice(0, 8).toUpperCase()}`}</span></div><h3>{title}</h3></div><span className={`job-state ${job.done ? 'done' : 'running'}`}>{job.done ? 'ЗАВЕРШЕНО' : 'В ПРОЦЕССЕ'}</span></div><div className="job-status-line"><span>{job.status}</span><b>{job.progress} / {job.total || '—'}</b></div><div className="progress-rail"><i style={{ width: `${percent}%` }}/></div>{job.historyId && !archive ? <div className="history-saved"><Check size={13}/> Сохранено в историю проверок · запись #{job.historyId}</div> : null}<div className="job-results">{job.rows.map((row, i) => <div className="job-row" key={`${row.profile}-${i}`}><div className="job-player"><span className="job-player-no">{String(i + 1).padStart(2, '0')}</span><a href={row.profile} target="_blank" rel="noreferrer">{row.profile}<ExternalLink size={12}/></a></div><div className="job-player-result"><strong className={row.price === null ? 'no-price' : ''}>{money(row.price)}</strong><span className={row.price !== null ? 'positive' : /ошибка|скрыт/i.test(row.status) ? 'negative' : ''}>{row.status}</span></div></div>)}</div><div className="job-log"><div className="log-label"><span>EVENT LOG</span><span>{job.logs.length} СОБЫТИЙ</span></div><pre>{job.logs.join('\n') || 'Ожидание событий…'}</pre></div></section>;
}

function HistoryPage({ items, isAdmin, scope, setScope, refresh }: { items: HistoryItem[]; isAdmin: boolean; scope: 'mine' | 'all'; setScope: (scope: 'mine' | 'all') => void; refresh: () => void }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<HistoryItem | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const q = query.trim().toLowerCase().replace(/^uid\s*/, '');
  const visible = !q ? items : items.filter(item => item.username.toLowerCase().includes(q) || String(item.user_id).padStart(5, '0').includes(q) || item.title.toLowerCase().includes(q));
  const showUser = scope === 'all';
  async function toggle(item: HistoryItem) {
    if (openId === item.id) { setOpenId(null); setDetail(null); return; }
    setOpenId(item.id); setDetail(null); setDetailError(''); setDetailBusy(true);
    try { setDetail(await api<HistoryItem>(`/api/history/${item.id}`)); }
    catch (error) { setDetailError((error as Error).message); }
    finally { setDetailBusy(false); }
  }
  function changeScope(next: 'mine' | 'all') { setOpenId(null); setDetail(null); setQuery(''); setScope(next); }
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">CHECK HISTORY <span className="tiny-status">● СОХРАНЯЕТСЯ НАВСЕГДА</span></div><h2>История <em>проверок</em></h2><p>Каждая проверка матча или Steam-профиля сохраняется в аккаунте пользователя: результаты, статусы и журнал событий.</p></div><div className="intro-stamp"><HistoryIcon size={22}/><span>ARCHIVE<br/>LOG</span></div></div>
    {isAdmin && <div className="admin-tabs"><button className={scope === 'mine' ? 'active' : ''} onClick={() => changeScope('mine')}><User size={16}/> Мои проверки</button><button className={scope === 'all' ? 'active' : ''} onClick={() => changeScope('all')}><Users size={16}/> Вся команда</button><button className="refresh-admin" onClick={refresh}><RefreshCw size={15}/> Обновить</button></div>}
    <section className="surface-card table-card"><div className="table-heading"><div><span className="eyebrow">{showUser ? 'TEAM LOG' : 'YOUR LOG'}</span><h3>{showUser ? 'Проверки всей команды' : 'Мои проверки'}</h3></div><span className="table-count">{visible.length} ЗАПИСЕЙ</span></div>
      <div className="history-toolbar"><div className="input-wrap"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={showUser ? 'Поиск: ник, UID или ID матча' : 'Поиск по ID матча или ссылке'}/></div>{!isAdmin && <button className="table-action" onClick={refresh}><RefreshCw size={14}/> Обновить</button>}</div>
      {!visible.length ? <div className="empty-table"><Clock3 size={24}/><b>Проверок пока нет</b><span>Запусти проверку матча или Steam-профиля, и она появится здесь.</span></div>
      : <div className="table-scroll"><table className="data-table history-table"><thead><tr><th>ДАТА</th>{showUser && <th>ПОЛЬЗОВАТЕЛЬ</th>}<th>ТИП</th><th>ЗАПРОС</th><th>ЛУЧШАЯ ОЦЕНКА</th><th>СТАТУС</th><th/></tr></thead><tbody>
        {visible.map(item => {
          const priced = item.rows.filter(row => row.price !== null);
          const best = priced.length ? Math.max(...priced.map(row => row.price as number)) : null;
          const open = openId === item.id;
          const tone = item.status === 'Проверка завершена' ? 'green' : /ошибка|прервано/i.test(item.status) ? 'red' : 'amber';
          return <Fragment key={item.id}>
            <tr className={`history-row ${open ? 'open' : ''}`} onClick={() => void toggle(item)}>
              <td>{dateTimeLabel(item.created_at)}</td>
              {showUser && <td><div className="user-cell"><div className="user-table-avatar">{item.username[0]?.toUpperCase()}</div><div><b>{item.username}</b><small>{uidLabel(item.user_id)}</small></div></div></td>}
              <td>{item.kind === 'match' ? 'Матч' : 'Steam'}</td>
              <td>{item.title.length > 46 ? `${item.title.slice(0, 46)}…` : item.title}</td>
              <td>{best === null ? '—' : money(best)} <small className="muted-small">{priced.length}/{item.total || 0} оценено</small></td>
              <td><span className={`status-badge ${tone}`}><i/>{item.status}</span></td>
              <td><span className="history-open">{open ? 'СВЕРНУТЬ' : 'ОТКРЫТЬ'}</span></td>
            </tr>
            {open && <tr className="history-detail"><td colSpan={showUser ? 7 : 6}>
              {detailBusy ? <div className="empty-table"><span className="spinner"/><span>Загружаем запись…</span></div>
              : detailError ? <div className="auth-toast error">{detailError}</div>
              : detail && <JobPanel archive title={detail.kind === 'match' ? 'Результаты матча' : 'Результат проверки профиля'} job={{ id: String(detail.id), kind: detail.kind, title: detail.title, status: detail.status, progress: detail.progress, total: detail.total, rows: detail.rows, logs: detail.logs || [], done: true }}/>}
            </td></tr>}
          </Fragment>;
        })}
      </tbody></table></div>}
    </section>
  </div>;
}
function AdminPanel({ mode, currentUserId, tab, setTab, users, invites, busy, uses, setUses, days, setDays, newInvite, setNewInvite, credential, setCredential, createInvite, revokeInvite, banUser, unbanUser, toggleUser, resetPassword, changeUserRole, refresh }: {
  mode: 'admin' | 'moderator'; currentUserId: number;
  tab: 'users' | 'invites'; setTab: (tab: 'users' | 'invites') => void; users: AdminUser[]; invites: Invite[]; busy: boolean;
  uses: string; setUses: (v: string) => void; days: string; setDays: (v: string) => void;
  newInvite: { code: string; uses: number; expires: number } | null; setNewInvite: (v: { code: string; uses: number; expires: number } | null) => void;
  credential: string | null; setCredential: (v: string | null) => void; createInvite: (event: FormEvent<HTMLFormElement>) => void;
  revokeInvite: (id: number) => void; banUser: (user: AdminUser) => void; unbanUser: (user: AdminUser) => void;
  toggleUser: (user: AdminUser) => void; resetPassword: (user: AdminUser) => void;
  changeUserRole: (user: AdminUser, role: Role) => void; refresh: () => void;
}) {
  const isAdmin = mode === 'admin';
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">{isAdmin ? 'ADMIN CONTROL CENTER' : 'TEAM MODERATION'} <span className="tiny-status">● {isAdmin ? 'ROOT ACCESS' : 'MODERATOR ACCESS'}</span></div><h2>{isAdmin ? <>Управление <em>командой</em></> : <>Модерация <em>участников</em></>}</h2><p>{isAdmin ? 'Выдавай роли, управляй инвайтами, отслеживай аккаунты и блокировки.' : 'Просматривай участников, блокируй нарушителей и управляй доступом. Назначать роли может только администратор.'}</p></div><div className="admin-seal">{isAdmin ? <Crown size={20}/> : <Shield size={20}/>}<span>{isAdmin ? <>ADMIN<br/>ONLY</> : <>MOD<br/>ONLY</>}</span></div></div>
    <div className="admin-summary"><div><span>УЧАСТНИКИ</span><b>{users.filter(u => u.role === 'user').length.toString().padStart(2, '0')}</b></div><div><span>МОДЕРАТОРЫ</span><b>{users.filter(u => u.role === 'moderator').length.toString().padStart(2, '0')}</b></div><div><span>ГЕНЕРАТОРЫ</span><b>{users.filter(u => u.role === 'invite_manager').length.toString().padStart(2, '0')}</b></div><div><span>ЗАБЛОКИРОВАНО</span><b>{users.filter(u => u.banned).length.toString().padStart(2, '0')}</b></div></div>
    <div className="admin-tabs">{isAdmin && <button className={tab === 'invites' ? 'active' : ''} onClick={() => setTab('invites')}><KeyRound size={16}/> Инвайт-ключи <span>{invites.length}</span></button>}<button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}><Users size={16}/> Пользователи <span>{users.length}</span></button><button className="refresh-admin" onClick={refresh}><RefreshCw size={15}/> Обновить</button></div>
    {isAdmin && tab === 'invites' ? <div className="admin-content-grid"><section className="surface-card invite-create-card"><div className="card-overline"><span>INVITE GENERATOR</span><span className="tag">ADMIN ONLY</span></div><div className="big-card-icon"><KeyRound size={20}/></div><h3>Создать инвайт</h3><p className="muted-copy">Ключ можно передать другу. При регистрации он обязательно укажет этот ключ. Секретная часть показывается только один раз.</p><form onSubmit={createInvite} className="invite-form"><label className="field-label">КОЛИЧЕСТВО РЕГИСТРАЦИЙ<select value={uses} onChange={e => setUses(e.target.value)}><option value="1">1 использование</option><option value="3">3 использования</option><option value="5">5 использований</option><option value="10">10 использований</option><option value="25">25 использований</option><option value="100">100 использований</option></select></label><label className="field-label">СРОК ДЕЙСТВИЯ<select value={days} onChange={e => setDays(e.target.value)}><option value="1">1 день</option><option value="7">7 дней</option><option value="14">14 дней</option><option value="30">30 дней</option><option value="90">90 дней</option><option value="365">365 дней</option></select></label><button className="button button-primary" disabled={busy}><Plus size={17}/> Сгенерировать ключ</button></form>
      {newInvite && <div className="generated-invite"><div className="generated-invite-top"><span><CheckCircle2 size={15}/> ИНВАЙТ СОЗДАН</span><button onClick={() => setNewInvite(null)}><X size={14}/></button></div><strong>{newInvite.code}</strong><div className="generated-meta"><span>{newInvite.uses} регистраций</span><span>до {dateLabel(newInvite.expires)}</span></div><button className="copy-key" onClick={() => { void navigator.clipboard.writeText(newInvite.code); }}><Copy size={15}/> Скопировать инвайт</button></div>}
    </section><section className="surface-card invite-how-card"><div className="card-overline"><span>ACCESS CONTROL</span><span className="tag muted-tag">HOW IT WORKS</span></div><h3>Как работают инвайты</h3><PipelineStep no="01" title="Администратор создаёт ключ" text="Выбирает количество регистраций и срок действия."/><PipelineStep no="02" title="Пользователь регистрируется" text="Вводит инвайт, логин и свой пароль. Без действующего ключа регистрация невозможна."/><PipelineStep no="03" title="Ключ становится недоступен" text="После заданного числа регистраций или окончания срока ключ перестаёт работать." last/><div className="aside-foot"><Shield size={15}/> Инвайты хранятся в базе в виде хеша — исходный ключ повторно не раскрывается.</div></section>
      <section className="surface-card full-width table-card"><div className="table-heading"><div><span className="eyebrow">ISSUED KEYS</span><h3>Список инвайтов</h3></div><span className="table-count">{invites.length} ЗАПИСЕЙ</span></div><InviteTable invites={invites} revoke={revokeInvite}/></section></div>
    : <section className="surface-card table-card"><div className="table-heading"><div><span className="eyebrow">{isAdmin ? 'MEMBER & ROLE MANAGEMENT' : 'MEMBER MODERATION'}</span><h3>{isAdmin ? 'Участники команды и роли' : 'Участники команды'}</h3><p>{isAdmin ? 'Меняй роль пользователя. Последнего администратора нельзя понизить.' : 'Модераторы могут управлять обычными участниками и генераторами инвайтов, но не другими модераторами и администраторами.'}</p></div><span className="table-count">{users.length} АККАУНТОВ</span></div>{credential && <div className="credential-reveal"><div><CheckCircle2 size={17}/><span>НОВЫЙ ПАРОЛЬ СОЗДАН — СОХРАНИ ЕГО СЕЙЧАС</span></div><code>{credential}</code><button onClick={() => { void navigator.clipboard.writeText(credential); }}><Copy size={14}/> Скопировать</button><button className="credential-close" onClick={() => setCredential(null)}><X size={14}/></button></div>}<UsersTable users={users} currentUserId={currentUserId} canManageRoles={isAdmin} canResetPassword={isAdmin} ban={banUser} unban={unbanUser} toggle={toggleUser} reset={resetPassword} changeRole={changeUserRole}/></section>}
  </div>;
}

function InviteManagerPanel({ quota, invites, newInvite, setNewInvite, busy, createInvite, refresh }: {
  quota: WeeklyInviteQuota | null; invites: Invite[]; newInvite: { code: string; uses: number; expires: number } | null;
  setNewInvite: (value: { code: string; uses: number; expires: number } | null) => void;
  busy: boolean; createInvite: () => void; refresh: () => void;
}) {
  const remaining = quota?.remaining ?? 0;
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow">PERSONAL INVITE ACCESS <span className="tiny-status">● ACTIVE ROLE</span></div><h2>Генератор <em>инвайтов</em></h2><p>Твоя роль позволяет выпускать до трёх одноразовых инвайтов в неделю.</p></div><div className="admin-seal"><KeyRound size={20}/><span>3 /<br/>WEEK</span></div></div>
    <div className="weekly-quota-card surface-card"><div><span className="eyebrow">НЕДЕЛЬНЫЙ ЛИМИТ</span><h3>{quota ? `${quota.used} из ${quota.limit}` : 'Загрузка…'} <small>инвайтов использовано</small></h3><p>{quota ? `Осталось ${quota.remaining}. Лимит обновится ${dateLabel(quota.resets_at)} (UTC).` : 'Проверяем доступный лимит.'}</p></div><div className="quota-dots">{[0, 1, 2].map(index => <span key={index} className={index < (quota?.used || 0) ? 'used' : ''}/>)}</div></div>
    <div className="admin-content-grid"><section className="surface-card invite-create-card"><div className="card-overline"><span>WEEKLY INVITE GENERATOR</span><span className="tag">{remaining} ОСТАЛОСЬ</span></div><div className="big-card-icon"><KeyRound size={20}/></div><h3>Создать инвайт</h3><p className="muted-copy">Каждый ключ можно использовать один раз. Он действует 7 дней. Секретный ключ показывается только после создания — сразу скопируй его.</p><button className="button button-primary" disabled={busy || !quota || remaining <= 0} onClick={createInvite}><Plus size={17}/> Сгенерировать инвайт</button>
      {newInvite && <div className="generated-invite"><div className="generated-invite-top"><span><CheckCircle2 size={15}/> ИНВАЙТ СОЗДАН</span><button onClick={() => setNewInvite(null)}><X size={14}/></button></div><strong>{newInvite.code}</strong><div className="generated-meta"><span>1 регистрация</span><span>до {dateLabel(newInvite.expires)}</span></div><button className="copy-key" onClick={() => { void navigator.clipboard.writeText(newInvite.code); }}><Copy size={15}/> Скопировать инвайт</button></div>}
    </section><section className="surface-card invite-how-card"><div className="card-overline"><span>YOUR PERMISSIONS</span><span className="tag muted-tag">WEEKLY LIMIT</span></div><h3>Правила роли</h3><PipelineStep no="01" title="Три инвайта в неделю" text="Лимит общий для твоего аккаунта и обновляется каждый понедельник в 00:00 UTC."/><PipelineStep no="02" title="Одна регистрация" text="Каждый созданный ключ подходит только для одного нового аккаунта."/><PipelineStep no="03" title="Срок — 7 дней" text="Если ключ не использован за 7 дней, он автоматически перестаёт работать." last/><div className="aside-foot"><Shield size={15}/> Лимит проверяется на сервере и хранится в базе данных.</div></section>
      <section className="surface-card full-width table-card"><div className="table-heading"><div><span className="eyebrow">YOUR ISSUED KEYS</span><h3>Созданные на этой неделе инвайты</h3></div><button className="table-action" onClick={refresh}><RefreshCw size={14}/> Обновить</button></div><InviteTable invites={invites} revoke={() => undefined} allowRevoke={false}/></section></div>
  </div>;
}

function InviteTable({ invites, revoke, allowRevoke = true }: { invites: Invite[]; revoke: (id: number) => void; allowRevoke?: boolean }) {
  if (!invites.length) return <div className="empty-table"><KeyRound size={24}/><b>Инвайтов пока нет</b><span>Создай первый ключ, чтобы пригласить участников команды.</span></div>;
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>КЛЮЧ</th><th>ИСПОЛЬЗОВАНИЯ</th><th>СОЗДАН</th><th>ИСТЕКАЕТ</th><th>СТАТУС</th>{allowRevoke && <th/>}</tr></thead><tbody>{invites.map(invite => <tr key={invite.id}><td><span className="code-cell"><KeyRound size={14}/>{invite.code_hint}</span></td><td>{invite.uses} / {invite.max_uses}</td><td>{dateLabel(invite.created_at)}</td><td>{dateLabel(invite.expires_at)}</td><td><StatusBadge status={invite.status}/></td>{allowRevoke && <td>{invite.status === 'Активен' && <button className="table-action danger" onClick={() => revoke(invite.id)}><Ban size={14}/> Отозвать</button>}</td>}</tr>)}</tbody></table></div>;
}
function UsersTable({ users, currentUserId, canManageRoles, canResetPassword, ban, unban, toggle, reset, changeRole }: {
  users: AdminUser[]; currentUserId: number; canManageRoles: boolean; canResetPassword: boolean;
  ban: (u: AdminUser) => void; unban: (u: AdminUser) => void; toggle: (u: AdminUser) => void;
  reset: (u: AdminUser) => void; changeRole: (u: AdminUser, role: Role) => void;
}) {
  return <div className="table-scroll"><table className="data-table users-data"><thead><tr><th>УЧАСТНИК</th><th>РОЛЬ</th><th>СОСТОЯНИЕ</th><th>РЕГИСТРАЦИЯ</th><th>УПРАВЛЕНИЕ</th></tr></thead><tbody>{users.map(target => {
    const protectedFromModerator = !canManageRoles && (target.role === 'admin' || target.role === 'moderator');
    const canModerateTarget = target.id !== currentUserId && !protectedFromModerator && target.role !== 'admin';
    return <tr key={target.id}><td><div className="user-cell"><div className="user-table-avatar">{target.username[0]?.toUpperCase()}</div><div><b>{target.username}</b><small>UID {String(target.id).padStart(5, '0')}</small></div></div></td>
      <td>{canManageRoles && target.id !== currentUserId ? <select className="role-select" value={target.role} onChange={event => changeRole(target, event.target.value as Role)} aria-label={`Роль пользователя ${target.username}`}><option value="user">Участник</option><option value="invite_manager">Генератор инвайтов</option><option value="moderator">Модератор</option><option value="admin">Администратор</option></select> : <RoleBadge role={target.role}/>}</td>
      <td><StatusBadge status={target.banned ? 'Заблокирован' : target.active ? 'Активен' : 'Отключён'}/>{target.ban_reason && target.banned && <small className="ban-reason">{target.ban_reason}</small>}</td><td>{dateLabel(target.created_at)}</td>
      <td>{target.id === currentUserId ? <span className="protected-label"><Shield size={13}/> Ваш аккаунт</span> : !canModerateTarget ? <span className="protected-label"><Shield size={13}/> Защищён</span> : <div className="user-actions">{target.banned ? <button className="table-action success" onClick={() => unban(target)}><UserCheck size={14}/> Разбанить</button> : <button className="table-action danger" onClick={() => ban(target)}><Ban size={14}/> Бан</button>}<button className="table-action" onClick={() => toggle(target)}>{target.active ? 'Отключить' : 'Включить'}</button>{canResetPassword && <button className="table-action" onClick={() => reset(target)} title="Сбросить пароль"><RefreshCw size={14}/></button>}</div>}</td>
    </tr>;
  })}</tbody></table></div>;
}
function RoleBadge({ role }: { role: Role }) {
  if (role === 'admin') return <span className="role-admin"><Crown size={13}/> Администратор</span>;
  if (role === 'moderator') return <span className="role-moderator"><Shield size={13}/> Модератор</span>;
  if (role === 'invite_manager') return <span className="role-invites"><KeyRound size={13}/> Инвайты · 3/нед.</span>;
  return <span className="role-member">Участник</span>;
}
function StatusBadge({ status }: { status: string }) {
  const kind = status === 'Активен' ? 'green' : status === 'Заблокирован' || status === 'Отозван' ? 'red' : status === 'Истёк' || status === 'Отключён' ? 'amber' : 'gray';
  return <span className={`status-badge ${kind}`}><i/>{status}</span>;
}
