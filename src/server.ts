import 'dotenv/config';
import express, { type NextFunction, type Request, type Response as ExpressResponse, type RequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Pool, neonConfig } from '@neondatabase/serverless';
import argon2 from 'argon2';
import { randomBytes, createHash } from 'node:crypto';

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket;

type Role = 'admin' | 'user';
interface AuthUser { id: number; username: string; role: Role; }
interface PlayerRow { profile: string; price: number | null; status: string; }
interface Job {
  id: string; kind: 'match' | 'steam'; title: string; status: string;
  progress: number; total: number; rows: PlayerRow[]; logs: string[]; done: boolean;
  ownerId: number; ownerName: string; historyId?: number;
}
interface SafeJob extends Omit<Job, 'ownerId' | 'ownerName'> {}
interface InviteRow {
  id: number; code_hint: string; max_uses: number; uses: number; expires_at: number;
  revoked_at: number | null; created_at: string; created_by: string;
}
interface UserRow {
  id: number; username: string; password_hash: string; role: Role; active: number;
  banned: number; ban_reason: string | null; created_at: string;
}

declare global {
  namespace Express { interface Request { user?: AuthUser; } }
}

const app = express();
const PORT = Number(process.env.PORT || 8080);
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'true').toLowerCase() !== 'false';
const COOKIE_NAME = 'makerow_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const STEAM_ID_BASE = 76561197960265728n;
const LZT_URL = 'https://api.lzt.market/steam-value';
const DISCORD_DEFAULT_CHANNEL = '1573865134806270074';
const JOB_LOG_LIMIT = 120;
const LZT_INTERVAL_MS = 3250;
const httpTimeoutMs = 45_000;

let pool: Pool | undefined;
let schemaPromise: Promise<void> | null = null;

function getPool(): Pool {
  const connectionString = (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || '').trim();
  if (!connectionString) throw Object.assign(new Error('На Vercel не задан DATABASE_URL. Подключи Neon Postgres в Storage → Connect.'), { status: 503 });
  if (!pool) pool = new Pool({ connectionString, max: 3 });
  return pool;
}

async function ensureDatabase(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  const pending = (async () => {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      ban_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_uq ON users (LOWER(username))');
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS users_one_admin_uq ON users (role) WHERE role = 'admin'");
    await db.query(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS invite_codes (
      id BIGSERIAL PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      code_hint TEXT NOT NULL,
      created_by BIGINT NOT NULL REFERENCES users(id),
      max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS api_rate_limits (
      rate_key TEXT PRIMARY KEY,
      next_request_at BIGINT NOT NULL
    )`);
    await db.query('CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)');
    await db.query(`CREATE TABLE IF NOT EXISTS check_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      username TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      result_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
      event_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query('CREATE INDEX IF NOT EXISTS check_history_user_idx ON check_history(user_id, id DESC)');

    const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    const existingAdmin = await db.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existingAdmin.rowCount === 0) {
      if (adminPassword.length < 16 || /^(REPLACE|CHANGE_THIS)/i.test(adminPassword)) {
        throw Object.assign(new Error('На сервере не задан ADMIN_PASSWORD (нужно не менее 16 символов). Добавь его в Vercel → Settings → Environment Variables и сделай Redeploy.'), { status: 503 });
      }
      const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
      await db.query(
        "INSERT INTO users (username, password_hash, role) SELECT $1, $2, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') ON CONFLICT DO NOTHING",
        [adminUsername, passwordHash]
      );
    }
    await db.query('DELETE FROM sessions WHERE expires_at <= $1', [nowUnix()]);
  })();
  const guarded = pending.catch(error => {
    schemaPromise = null;
    throw error;
  });
  schemaPromise = guarded;
  return guarded;
}

function nowUnix(): number { return Math.floor(Date.now() / 1000); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function randomToken(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
function asyncRoute(fn: (req: Request, res: ExpressResponse) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void fn(req, res).catch(next); };
}
function fail(status: number, message: string): never {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  throw error;
}
function validUsername(username: string): boolean {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(username);
}
function randomInviteCode(): string { return `MW-${randomBytes(8).toString('hex').toUpperCase()}`; }
function getSessionToken(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie || '';
  const part = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE_NAME}=`));
  return part ? part.slice(COOKIE_NAME.length + 1) : undefined;
}
function setSessionCookie(res: ExpressResponse, token: string): void {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`);
}
function clearSessionCookie(res: ExpressResponse): void {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}
async function issueSession(userId: number): Promise<string> {
  const raw = randomToken();
  await getPool().query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [sha256(raw), userId, nowUnix() + SESSION_SECONDS]);
  return raw;
}
const auth: RequestHandler = (req, res, next) => {
  void (async () => {
    const token = getSessionToken(req);
    if (!token) { res.status(401).json({ error: 'Войди в аккаунт' }); return; }
    const result = await getPool().query(
      `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = TRUE AND u.banned = FALSE`,
      [sha256(token), nowUnix()]
    );
    const row = result.rows[0] as { id: string | number; username: string; role: Role } | undefined;
    if (!row) { res.status(401).json({ error: 'Сессия истекла или доступ к аккаунту закрыт' }); return; }
    req.user = { id: Number(row.id), username: row.username, role: row.role };
    next();
  })().catch(next);
};
function adminOnly(req: Request, res: ExpressResponse, next: NextFunction): void {
  if (req.user?.role !== 'admin') { res.status(403).json({ error: 'Эта функция доступна только администраторам' }); return; }
  next();
}
function currentUser(req: Request): AuthUser {
  if (!req.user) fail(401, 'Войди в аккаунт');
  return req.user;
}
function safeJob(job: Job): SafeJob {
  const { ownerId: _ownerId, ownerName: _ownerName, ...view } = job;
  return view;
}
function pushLog(job: Job, message: string): void {
  job.logs.push(`[${new Date().toLocaleTimeString('ru-RU', { hour12: false })}] ${message}`);
  if (job.logs.length > JOB_LOG_LIMIT) job.logs.splice(0, job.logs.length - JOB_LOG_LIMIT);
}
function createJob(user: AuthUser, kind: Job['kind'], title: string): Job {
  const id = randomToken(18);
  const job: Job = { id, kind, title, status: 'В очереди', progress: 0, total: 0, rows: [], logs: [], done: false, ownerId: user.id, ownerName: user.username };
  return job;
}
async function saveHistory(job: Job): Promise<number | undefined> {
  try {
    if (!job.done) { job.status = 'Прервано из-за ошибки'; job.done = true; }
    const result = await getPool().query(
      `INSERT INTO check_history (user_id, username, kind, title, status, total, progress, result_rows, event_logs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id`,
      [job.ownerId, job.ownerName, job.kind, job.title, job.status, job.total, job.progress, JSON.stringify(job.rows), JSON.stringify(job.logs)]
    );
    return Number(result.rows[0].id);
  } catch (error) {
    console.error('Не удалось сохранить историю проверки', error);
    return undefined;
  }
}
function historyView(row: any, withLogs: boolean) {
  const view: Record<string, unknown> = {
    id: Number(row.id), user_id: Number(row.user_id), username: row.username, kind: row.kind, title: row.title,
    status: row.status, total: Number(row.total), progress: Number(row.progress), rows: row.result_rows, created_at: row.created_at
  };
  if (withLogs) view.logs = row.event_logs;
  return view;
}
function shortText(input: string, max = 220): string { return input.replace(/[\r\n\t]+/g, ' ').slice(0, max); }
function parseNumericId(input: string): bigint | null {
  const matches = input.match(/\d+/g);
  if (!matches?.length) return null;
  try { return BigInt(matches[matches.length - 1]!); } catch { return null; }
}
function normalizeAccountId(raw: bigint): bigint | null {
  const value = raw >= STEAM_ID_BASE && raw < STEAM_ID_BASE + 4294967295n ? raw - STEAM_ID_BASE : raw;
  return value > 0n && value < 4294967295n ? value : null;
}
function getBigInt(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) { try { return BigInt(value); } catch { return null; } }
  return null;
}
async function stratzPlayers(matchId: bigint): Promise<{ ids: bigint[]; totalSlots: number; missing: number }> {
  const token = process.env.STRATZ_API_TOKEN || '';
  if (!token.trim()) throw new Error('На сервере не задан STRATZ_API_TOKEN');
  const query = `{match(id:${matchId}){players{steamAccountId steamAccount{id isAnonymous}}}}`;
  const response = await fetch('https://api.stratz.com/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'STRATZ_API' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(httpTimeoutMs)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`STRATZ HTTP ${response.status}: ${shortText(body)}`);
  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error('STRATZ вернул некорректный JSON'); }
  if (data?.errors?.[0]?.message) throw new Error(`STRATZ: ${shortText(String(data.errors[0].message))}`);
  const players = data?.data?.match?.players;
  if (!Array.isArray(players)) throw new Error('STRATZ не вернул список участников матча');
  let missing = 0;
  const ids = new Set<string>();
  for (const player of players) {
    const raw = getBigInt(player?.steamAccountId) ?? getBigInt(player?.steamAccount?.id);
    const id = raw === null ? null : normalizeAccountId(raw);
    if (id === null) missing++;
    else ids.add(id.toString());
  }
  return { ids: [...ids].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), totalSlots: players.length, missing };
}
function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const filtered = value.trim().replace(/[^\d.,]/g, '');
  if (!filtered) return null;
  let normalized = filtered;
  if (filtered.includes('.')) normalized = filtered.replace(/,/g, '');
  else if (filtered.includes(',')) {
    const decimal = filtered.split(',').at(-1) || '';
    normalized = decimal.length === 3 ? filtered.replace(/,/g, '') : filtered.replace(',', '.');
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
function extractTotal(value: any): number | null {
  const candidates = [
    value?.data?.totalValue, value?.data?.total_value, value?.data?.inventory_value,
    value?.data?.steam_inventory_value, value?.data?.steam_value,
    value?.totalValue, value?.total_value, value?.inventory_value,
    value?.steam_inventory_value, value?.steam_value
  ];
  for (const candidate of candidates) { const amount = parseMoney(candidate); if (amount !== null) return amount; }
  return null;
}
function isHiddenInventory(body: string): boolean {
  const lower = body.toLowerCase();
  return ['инвентарь данного профиля скрыт', 'инвентарь профиля скрыт', 'инвентарь скрыт', 'inventory is hidden', 'private inventory', 'inventory is private'].some(x => lower.includes(x));
}
function normalizeSteamLink(input: string): string {
  const value = input.trim();
  if (!value) fail(400, 'Вставь Steam-ссылку или SteamID64');
  if (/^\d+$/.test(value)) {
    const id = BigInt(value);
    if (id < STEAM_ID_BASE || id >= STEAM_ID_BASE + 4294967295n) fail(400, 'Числовой ID должен быть SteamID64');
    return value;
  }
  let url: URL;
  try { url = new URL(value); } catch { fail(400, 'Вставь полную ссылку https://steamcommunity.com/profiles/... или /id/...'); }
  if (!['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname.toLowerCase())) fail(400, 'Разрешены только ссылки steamcommunity.com');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !['profiles', 'id'].includes(parts[0]!) || !parts[1]) fail(400, 'Ссылка должна иметь вид /profiles/SteamID64 или /id/имя');
  return `https://steamcommunity.com/${parts[0]}/${parts[1]}`;
}
function delay(ms: number): Promise<void> { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }
async function lztPriceRequest(profile: string): Promise<number> {
  const token = process.env.LZT_API_TOKEN || '';
  if (!token.trim()) throw new Error('На сервере не задан LZT_API_TOKEN');
  let response: Response;
    try {
      response = await fetch(LZT_URL + '?' + new URLSearchParams({ link: profile, app_id: '570', currency: 'usd' }), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(httpTimeoutMs)
      });
    } catch (error) { throw new Error(`LZT Market: ошибка соединения: ${error instanceof Error ? error.message : 'unknown error'}`); }
    const body = await response.text();
    if (response.status === 429) {
      const headerValue = response.headers.get('retry-after');
      const retry = headerValue && /^\d+$/.test(headerValue) ? Number(headerValue) : 10;
      throw new Error(`RETRY_AFTER:${Math.min(180, Math.max(3, retry))}`);
    }
    if (response.status === 401) throw new Error('LZT Market: токен на сервере недействителен (HTTP 401)');
    if (response.status === 403) {
      if (isHiddenInventory(body)) throw new Error('HIDDEN: Инвентарь данного профиля скрыт');
      throw new Error(`LZT Market: доступ к steam-value запрещён (HTTP 403): ${shortText(body)}`);
    }
    if (!response.ok) throw new Error(`LZT Market HTTP ${response.status}: ${shortText(body)}`);
    let data: any;
    try { data = JSON.parse(body); } catch { throw new Error(`LZT Market: неверный JSON: ${shortText(body)}`); }
    if (data?.errors?.[0]) throw new Error(`LZT Market: ${String(data.errors[0])}`);
    if (data?.error) throw new Error(`LZT Market: ${String(data.error)}`);
    const total = extractTotal(data);
    if (total === null) throw new Error(`LZT Market: не найдено поле общей стоимости. Ответ: ${shortText(body)}`);
    return total;
}
async function reserveLztSlot(): Promise<void> {
  const now = Date.now();
  const interval = LZT_INTERVAL_MS;
  const result = await getPool().query(
    `INSERT INTO api_rate_limits (rate_key, next_request_at) VALUES ('lzt', $1::BIGINT + $2::BIGINT)
     ON CONFLICT (rate_key) DO UPDATE
     SET next_request_at = GREATEST(api_rate_limits.next_request_at, $1::BIGINT) + $2::BIGINT
     RETURNING next_request_at`, [now, interval]
  );
  const scheduledAt = Number(result.rows[0]?.next_request_at ?? now + interval) - interval;
  const wait = Math.max(0, scheduledAt - Date.now());
  if (wait) await delay(wait);
}
async function lztPrice(profile: string): Promise<number> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await reserveLztSlot();
    try {
      return await lztPriceRequest(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryMatch = message.match(/^RETRY_AFTER:(\d+)/);
      if (!retryMatch) throw error;
      if (attempt === 2) throw new Error('LZT Market: HTTP 429 после повторной попытки; попробуй позже');
      await delay(Math.min(180, Math.max(3, Number(retryMatch[1]))) * 1000);
    }
  }
  throw new Error('LZT Market: не удалось получить оценку');
}
async function discordSend(content: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN || '';
  if (!token.trim()) throw new Error('Discord-бот не настроен на сервере');
  const channel = process.env.DISCORD_CHANNEL_ID || DISCORD_DEFAULT_CHANNEL;
  const response = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: 'POST', headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 1850), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(20_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}: ${shortText(body)}`);
}
async function runMatchJob(job: Job, matchId: bigint, onlyOverOne: boolean, onlyOver120: boolean): Promise<void> {
  job.status = 'Получаю игроков из STRATZ…';
  pushLog(job, `Пользователь: ${job.ownerName}. Матч: ${matchId}`);
  let roster: Awaited<ReturnType<typeof stratzPlayers>>;
  try { roster = await stratzPlayers(matchId); }
  catch (error) { pushLog(job, error instanceof Error ? error.message : String(error)); job.status = 'Ошибка получения состава матча'; job.done = true; return; }
  const total = roster.ids.length;
  job.total = total;
  pushLog(job, `STRATZ вернул слотов: ${roster.totalSlots}; доступно SteamID: ${total}; без SteamID: ${roster.missing}.`);
  if (roster.missing > 0) pushLog(job, `У ${roster.missing} слотов нет SteamID; LZT не может оценить их профиль.`);
  if (!total) { job.status = 'В матче нет доступных SteamID'; job.done = true; return; }
  const threshold = onlyOver120 ? 120 : onlyOverOne ? 1 : null;
  job.rows = roster.ids.map(id => ({ profile: `https://steamcommunity.com/profiles/${STEAM_ID_BASE + id}`, price: null, status: 'В очереди' }));
  const report: Array<{ profile: string; price: number }> = [];
  let hidden = 0; let errors = 0;
  for (let i = 0; i < roster.ids.length; i++) {
    const profile = job.rows[i]!.profile;
    job.status = `Проверяю ${i + 1}/${total} через LZT…`;
    try {
      const price = await lztPrice(profile);
      const visible = threshold === null || price >= threshold;
      job.rows[i] = { profile, price, status: visible ? 'Найдено — добавлен в результаты' : `$${price.toFixed(2)} — ниже порога, скрыт фильтром` };
      if (visible) report.push({ profile, price });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('HIDDEN:')) {
        hidden++; job.rows[i] = { profile, price: null, status: 'Скрытый инвентарь' }; pushLog(job, `Скрытый инвентарь: ${profile}`);
      } else {
        errors++; job.rows[i] = { profile, price: null, status: `Ошибка: ${message}` }; pushLog(job, `${profile}: ${message}`);
        if (/HTTP 401|HTTP 403|HTTP 429/.test(message)) {
          pushLog(job, 'Проверка остановлена из-за ошибки токена/доступа/лимита LZT.');
          for (let j = i + 1; j < job.rows.length; j++) job.rows[j]!.status = 'Не проверен: остановлено из-за ошибки LZT';
          job.progress = i + 1; break;
        }
      }
    }
    job.progress = i + 1;
  }
  pushLog(job, `Итог: обработано ${job.progress}/${total}; скрытых ${hidden}; ошибок ${errors}; найдено по фильтру ${report.length}.`);
  report.sort((a, b) => b.price - a.price);
  let message = `**MAKEROW TEAMWORK**\n🎮 Матч Dota 2: \`${matchId}\`\n👤 Проверку запустил: **${job.ownerName}**\n🔎 Обработано: ${job.progress}/${total} · 🔒 скрытых: ${hidden} · ⚠️ ошибок: ${errors}\n\n`;
  if (!report.length) message += 'Подходящих инвентарей по выбранному фильтру не найдено.\n';
  for (const row of report) message += `${row.price >= 120 ? '💎' : row.price >= 1 ? '💰' : '▫️'} **$${row.price.toFixed(2)}** — ${row.profile}\n`;
  message += '\n💎 от $120 · 💰 от $1 · Оценка LZT Market.';
  try { await discordSend(message); pushLog(job, 'Результаты отправлены в Discord.'); }
  catch (error) { pushLog(job, `Discord: ${error instanceof Error ? error.message : String(error)}`); }
  job.status = 'Проверка завершена'; job.done = true;
}
async function runSteamJob(job: Job, link: string): Promise<void> {
  job.status = 'Проверяю ссылку через LZT Market…'; job.total = 1; job.rows = [{ profile: link, price: null, status: 'Проверяется через LZT Market' }];
  try {
    const price = await lztPrice(link);
    job.rows[0] = { profile: link, price, status: 'Инвентарь оценён' };
    pushLog(job, `Стоимость инвентаря: $${price.toFixed(2)} USD`);
    const icon = price >= 120 ? '💎' : price >= 1 ? '💰' : '▫️';
    try { await discordSend(`**MAKEROW TEAMWORK**\n👤 Проверку запустил: **${job.ownerName}**\n${icon} **$${price.toFixed(2)} USD** — ${link}\nОценка Dota 2 через LZT Market.`); pushLog(job, 'Результат отправлен в Discord.'); }
    catch (error) { pushLog(job, `Discord: ${error instanceof Error ? error.message : String(error)}`); }
    job.progress = 1; job.status = 'Проверка завершена';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.rows[0] = { profile: link, price: null, status: message.startsWith('HIDDEN:') ? 'Скрытый инвентарь' : `Ошибка: ${message}` };
    pushLog(job, message.startsWith('HIDDEN:') ? 'Инвентарь профиля скрыт — цену получить нельзя.' : message);
    job.progress = 1; job.status = message.startsWith('HIDDEN:') ? 'Инвентарь скрыт' : 'Ошибка проверки';
  }
  job.done = true;
}

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"]
    }
  }, crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток входа. Попробуй через 15 минут.' } });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток регистрации. Попробуй позже.' } });
const checkLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много проверок за короткое время. Попробуй через минуту.' } });

// Initialize the shared Neon database once per warm function instance.
app.use((req, res, next) => { void ensureDatabase().then(() => next()).catch(next); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'makerow-teamwork', runtime: 'vercel-functions' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'makerow-teamwork', runtime: 'vercel-functions' }));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password || username.length > 64 || password.length > 256) fail(400, 'Проверь логин и пароль');
  const result = await getPool().query(
    'SELECT id, username, password_hash, role, active, banned FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [username]
  );
  const row = result.rows[0] as { id: string | number; username: string; password_hash: string; role: Role; active: boolean; banned: boolean } | undefined;
  if (!row || !(await argon2.verify(row.password_hash, password))) fail(401, 'Неверный логин или пароль');
  if (row.banned) fail(403, 'Аккаунт заблокирован администратором');
  if (!row.active) fail(403, 'Доступ к аккаунту отключён администратором');
  const token = await issueSession(Number(row.id));
  setSessionCookie(res, token);
  res.json({ user: { id: Number(row.id), username: row.username, role: row.role } });
}));

app.post('/api/auth/register', registerLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const inviteCode = String(req.body?.invite_code || '').trim().toUpperCase();
  if (!validUsername(username)) fail(400, 'Логин: 3–32 символа, латиница, цифры, точка, дефис и подчёркивание');
  if (password.length < 10 || password.length > 128) fail(400, 'Пароль должен содержать от 10 до 128 символов');
  if (!inviteCode || inviteCode.length > 80) fail(400, 'Для регистрации обязательно нужен инвайт-ключ');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const client = await getPool().connect();
  let result: { id: number; token: string };
  try {
    await client.query('BEGIN');
    const inviteResult = await client.query(
      'SELECT id, max_uses, uses, expires_at, revoked_at FROM invite_codes WHERE code_hash = $1 FOR UPDATE', [sha256(inviteCode)]
    );
    const invite = inviteResult.rows[0] as { id: string | number; max_uses: number; uses: number; expires_at: string | number; revoked_at: string | number | null } | undefined;
    if (!invite || invite.revoked_at !== null || Number(invite.expires_at) <= nowUnix() || invite.uses >= invite.max_uses) {
      fail(400, 'Инвайт-ключ недействителен, истёк или уже использован');
    }
    const userResult = await client.query(
      "INSERT INTO users (username, password_hash, role, active, banned) VALUES ($1, $2, 'user', TRUE, FALSE) RETURNING id",
      [username, passwordHash]
    );
    const id = Number(userResult.rows[0].id);
    await client.query('UPDATE invite_codes SET uses = uses + 1 WHERE id = $1', [invite.id]);
    const token = randomToken();
    await client.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), id, nowUnix() + SESSION_SECONDS]);
    await client.query('COMMIT');
    result = { id, token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string })?.code === '23505') fail(409, 'Такой логин уже занят');
    throw error;
  } finally { client.release(); }
  setSessionCookie(res, result.token);
  res.status(201).json({ user: { id: result.id, username, role: 'user' } });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = getSessionToken(req);
  if (token) await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  clearSessionCookie(res); res.json({ ok: true });
}));
app.get('/api/auth/me', auth, (req, res) => res.json({ id: req.user!.id, username: req.user!.username, role: req.user!.role }));

app.use('/api/admin', auth, adminOnly);
app.get('/api/admin/users', auth, asyncRoute(async (_req, res) => {
  const result = await getPool().query('SELECT id, username, role, active, banned, ban_reason, created_at FROM users ORDER BY id ASC');
  res.json(result.rows.map(row => ({ ...row, id: Number(row.id), active: row.active ? 1 : 0, banned: row.banned ? 1 : 0 })));
}));
app.post('/api/admin/invites', auth, asyncRoute(async (req, res) => {
  const maxUses = Math.max(1, Math.min(100, Number.parseInt(String(req.body?.max_uses ?? '1'), 10) || 1));
  const expiresDays = Math.max(1, Math.min(365, Number.parseInt(String(req.body?.expires_days ?? '7'), 10) || 7));
  const code = randomInviteCode();
  const hint = `${code.slice(0, 7)}••••••••`;
  const expiresAt = nowUnix() + expiresDays * 86400;
  const result = await getPool().query(
    'INSERT INTO invite_codes (code_hash, code_hint, created_by, max_uses, uses, expires_at) VALUES ($1, $2, $3, $4, 0, $5) RETURNING id',
    [sha256(code), hint, req.user!.id, maxUses, expiresAt]
  );
  res.status(201).json({ id: Number(result.rows[0].id), code, code_hint: hint, max_uses: maxUses, uses: 0, expires_at: expiresAt });
}));
app.get('/api/admin/invites', auth, asyncRoute(async (_req, res) => {
  const result = await getPool().query(`SELECT i.id, i.code_hint, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at, u.username AS created_by
    FROM invite_codes i JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 150`);
  const output = result.rows.map((invite: any) => {
    const row = { ...invite, id: Number(invite.id), expires_at: Number(invite.expires_at), revoked_at: invite.revoked_at === null ? null : Number(invite.revoked_at) };
    return { ...row, status: row.revoked_at ? 'Отозван' : row.expires_at <= nowUnix() ? 'Истёк' : row.uses >= row.max_uses ? 'Использован' : 'Активен' };
  });
  res.json(output);
}));
app.post('/api/admin/invites/:id/revoke', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const result = await getPool().query('UPDATE invite_codes SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING id', [nowUnix(), id]);
  if (!result.rowCount) fail(404, 'Активный инвайт не найден');
  res.json({ ok: true });
}));
app.post('/api/admin/users/:id/ban', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id === req.user!.id) fail(400, 'Нельзя заблокировать собственную учётную запись');
  const reason = String(req.body?.reason || 'Заблокирован администратором').trim().slice(0, 240);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const target = await client.query("UPDATE users SET banned = TRUE, ban_reason = $1 WHERE id = $2 AND role = 'user' RETURNING id", [reason, id]);
    if (!target.rowCount) fail(404, 'Пользователь не найден или это администратор');
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  res.json({ ok: true, banned: true });
}));
app.post('/api/admin/users/:id/unban', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const result = await getPool().query("UPDATE users SET banned = FALSE, ban_reason = NULL WHERE id = $1 AND role = 'user' AND banned = TRUE RETURNING id", [id]);
  if (!result.rowCount) fail(404, 'Заблокированный пользователь не найден');
  res.json({ ok: true, banned: false });
}));
app.post('/api/admin/users/:id/toggle', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id === req.user!.id) fail(400, 'Нельзя отключить собственную учётную запись');
  const client = await getPool().connect();
  let active: boolean;
  try {
    await client.query('BEGIN');
    const row = await client.query("SELECT active FROM users WHERE id = $1 AND role = 'user' FOR UPDATE", [id]);
    if (!row.rowCount) fail(404, 'Пользователь не найден или это администратор');
    active = !Boolean(row.rows[0].active);
    await client.query('UPDATE users SET active = $1 WHERE id = $2', [active, id]);
    if (!active) await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  res.json({ ok: true, active });
}));
app.post('/api/admin/users/:id/reset-password', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const target = await getPool().query("SELECT id FROM users WHERE id = $1 AND role = 'user'", [id]);
  if (!target.rowCount) fail(404, 'Пользователь не найден или это администратор');
  const password = randomToken(12);
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
  await getPool().query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.json({ ok: true, temporary_password: password });
}));

app.post('/api/check/match', auth, checkLimiter, asyncRoute(async (req, res) => {
  const raw = String(req.body?.match_id || '').trim();
  const matchId = parseNumericId(raw);
  if (!matchId || matchId <= 0n || raw.length > 120) fail(400, 'Введи корректный ID матча Dota 2');
  if (!(process.env.STRATZ_API_TOKEN || '').trim() || !(process.env.LZT_API_TOKEN || '').trim()) fail(503, 'Администратор ещё не настроил STRATZ/LZT API на сервере');
  const job = createJob(currentUser(req), 'match', `Матч ${matchId}`);
  try { await runMatchJob(job, matchId, Boolean(req.body?.only_over_one), Boolean(req.body?.only_over_120)); }
  finally { job.historyId = await saveHistory(job); }
  res.json(safeJob(job));
}));
app.post('/api/check/steam', auth, checkLimiter, asyncRoute(async (req, res) => {
  const link = normalizeSteamLink(String(req.body?.link || ''));
  if (!(process.env.LZT_API_TOKEN || '').trim()) fail(503, 'Администратор ещё не настроил LZT API на сервере');
  const job = createJob(currentUser(req), 'steam', link);
  try { await runSteamJob(job, link); }
  finally { job.historyId = await saveHistory(job); }
  res.json(safeJob(job));
}));

const HISTORY_COLUMNS = 'id, user_id, username, kind, title, status, total, progress, result_rows, created_at';
app.get('/api/history', auth, asyncRoute(async (req, res) => {
  const result = await getPool().query(`SELECT ${HISTORY_COLUMNS} FROM check_history WHERE user_id = $1 ORDER BY id DESC LIMIT 300`, [req.user!.id]);
  res.json(result.rows.map(row => historyView(row, false)));
}));
app.get('/api/admin/history', asyncRoute(async (_req, res) => {
  const result = await getPool().query(`SELECT ${HISTORY_COLUMNS} FROM check_history ORDER BY id DESC LIMIT 500`);
  res.json(result.rows.map(row => historyView(row, false)));
}));
app.get('/api/history/:id', auth, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Некорректный ID записи');
  const result = await getPool().query(`SELECT ${HISTORY_COLUMNS}, event_logs FROM check_history WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row || (Number(row.user_id) !== req.user!.id && req.user!.role !== 'admin')) fail(404, 'Запись не найдена');
  res.json(historyView(row, true));
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));

app.use((error: Error & { status?: number }, _req: Request, res: ExpressResponse, _next: NextFunction) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 && status !== 503 ? 'Внутренняя ошибка сервера' : error.message });
});

export default app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MAKEROW TEAMWORK (TypeScript) API listening on port ${PORT}`);
    console.log('Invite-only registration is enabled.');
  });
}
