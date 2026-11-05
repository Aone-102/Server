/**
 * 링크챗 — Cloudflare Workers (Freebuff Sites) 서버
 *
 * - REST: 게스트 로그인(아이디+닉네임), 방 목록/검색/생성/설정, 코드 입장,
 *         메시지, 친구 요청/수락
 * - D1: 사용자 · 방 · 방 멤버 · 메시지 · 친구 저장, 세션 서명 키 보관
 * - Sites realtime: 방 단위 브로드캐스트 + 프레즌스 (티켓은 쿠키 세션으로 발급)
 *
 * 방 공개 범위
 *   public  — 로비에 노출, 누구나 입장
 *   invite  — 로비에 숨김, 방 코드를 아는 사람만 입장
 *   private — 로비에 숨김, 방장이 친구로 초대한 사람만 입장
 */

const SESSION_COOKIE = 'lc_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_MESSAGE_LENGTH = 1000;
const HISTORY_LIMIT = 60;
const USER_ID_RE = /^[a-zA-Z0-9_.-]{3,20}$/;
const REALTIME_ROOM_RE = /^room:([A-Za-z0-9_-]{4,24})$/;
const REALTIME_CHANNEL_RE = /^ch:([A-Za-z0-9_-]{4,24})$/;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const VISIBILITIES = new Set(['public', 'invite', 'private']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------------------------------------------ *
 * D1 스키마
 * ------------------------------------------------------------------ */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     nickname TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rooms (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     owner_id TEXT NOT NULL,
     visibility TEXT NOT NULL DEFAULT 'public',
     code TEXT,
     created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     room_id TEXT,
     user_id TEXT NOT NULL,
     nickname TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, created_at, id)`,
  `CREATE TABLE IF NOT EXISTS room_members (
     room_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     joined_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS friends (
     user_id TEXT NOT NULL,
     friend_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, friend_id)
   )`,
  `CREATE TABLE IF NOT EXISTS friend_requests (
     id TEXT PRIMARY KEY,
     from_id TEXT NOT NULL,
     to_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     responded_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests (to_id, status)`,
  `CREATE TABLE IF NOT EXISTS moderation_log (
     id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
     actor_id TEXT NOT NULL,
     actor_nickname TEXT NOT NULL,
     author_id TEXT NOT NULL,
     author_nickname TEXT NOT NULL,
     message_id TEXT NOT NULL,
     message_text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_moderation_room ON moderation_log (room_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS channels (
     id TEXT PRIMARY KEY,
     room_id TEXT NOT NULL,
     name TEXT NOT NULL,
     position INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_room_name ON channels (room_id, name)`,
  `CREATE TABLE IF NOT EXISTS channel_reads (
     user_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     read_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, channel_id)
   )`,
  `CREATE TABLE IF NOT EXISTS channel_positions (
     user_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     scroll_top INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, channel_id)
   )`,
];

const MIGRATIONS = [
  `ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
  `ALTER TABLE rooms ADD COLUMN code TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_code ON rooms (code)`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members (user_id)`,
  `ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`,
  `ALTER TABLE messages ADD COLUMN channel_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at, id)`,
  `INSERT INTO channels (id, room_id, name, position, created_at)
   SELECT lower(hex(randomblob(4))), rooms.id, '일반', 0, rooms.created_at FROM rooms
   WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.room_id = rooms.id)`,
  `UPDATE messages SET channel_id = (
     SELECT c.id FROM channels c WHERE c.room_id = messages.room_id
     ORDER BY c.position ASC LIMIT 1
   ) WHERE room_id IS NOT NULL AND channel_id IS NULL`,
];

let schemaPromise;
function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
      for (const sql of MIGRATIONS) {
        try {
          await env.DB.prepare(sql).run();
        } catch {
          // 이미 적용된 마이그레이션은 무시한다.
        }
      }
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

/* ------------------------------------------------------------------ *
 * 공통 헬퍼
 * ------------------------------------------------------------------ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > 20_000) return null;
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function toB64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const chunk of String(header).split(';')) {
    const index = chunk.indexOf('=');
    if (index < 0) continue;
    const key = chunk.slice(0, index).trim();
    if (key) cookies[key] = chunk.slice(index + 1).trim();
  }
  return cookies;
}

function sessionCookie(token, { secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_MS / 1000}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearedCookie({ secure }) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function createRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

/* ------------------------------------------------------------------ *
 * 세션 (HMAC 서명 쿠키)
 * ------------------------------------------------------------------ */

let cachedSecret = null;
let cachedKey = null;
let cachedKeySecret = null;

async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;

  const existing = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind('session_secret')
    .first();
  if (existing?.value) {
    cachedSecret = existing.value;
    return cachedSecret;
  }

  const generated = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await env.DB.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .bind('session_secret', generated)
    .run();

  const stored = await env.DB.prepare('SELECT value FROM meta WHERE key = ?')
    .bind('session_secret')
    .first();
  cachedSecret = stored?.value ?? generated;
  return cachedSecret;
}

async function hmacKey(secret) {
  if (cachedKey && cachedKeySecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKeySecret = secret;
  return cachedKey;
}

async function sign(secret, payload) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toB64url(new Uint8Array(signature));
}

async function createSession(env, userId) {
  const secret = await sessionSecret(env);
  const payload = toB64url(
    encoder.encode(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_MAX_AGE_MS })),
  );
  return `${payload}.${await sign(secret, payload)}`;
}

async function verifySession(env, token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const secret = await sessionSecret(env);
  if (!safeEqual(signature, await sign(secret, payload))) return null;

  try {
    const data = JSON.parse(decoder.decode(fromB64url(payload)));
    if (!data?.uid || !data?.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function currentUser(env, request) {
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  const session = await verifySession(env, token);
  if (!session) return null;
  const row = await env.DB.prepare('SELECT id, nickname FROM users WHERE id = ?')
    .bind(session.uid)
    .first();
  return row ?? null;
}

/* ------------------------------------------------------------------ *
 * 요청 검증 / 저장소 접근
 * ------------------------------------------------------------------ */

function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = new Set([new URL(request.url).origin]);
  if (env.APP_ORIGIN) allowed.add(env.APP_ORIGIN);
  return allowed.has(origin);
}

function realtimeRoom(roomId) {
  return roomId ? `room:${roomId}` : 'global';
}

async function getRoom(env, roomId) {
  return env.DB.prepare(
    `SELECT id, name, description, owner_id AS ownerId, visibility, code,
            created_at AS createdAt, last_activity_at AS lastActivityAt
     FROM rooms WHERE id = ?`,
  )
    .bind(roomId)
    .first();
}

function mapRoom(row, { includeCode = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.ownerId,
    visibility: row.visibility ?? 'public',
    ...(includeCode ? { code: row.code } : {}),
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    lastMessage: row.lastNickname
      ? { nickname: row.lastNickname, text: row.lastText, createdAt: row.lastCreatedAt }
      : null,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    roomId: row.roomId ?? null,
    channelId: row.channelId ?? null,
    userId: row.userId,
    nickname: row.nickname,
    text: row.text,
    createdAt: row.createdAt,
  };
}

function mapChannel(row) {
  return {
    id: row.id,
    roomId: row.roomId,
    name: row.name,
    position: row.position,
    createdAt: row.createdAt,
  };
}

async function isMember(env, roomId, userId) {
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?',
  )
    .bind(roomId, userId)
    .first();
  return Boolean(row?.ok);
}

async function addMember(env, roomId, userId) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)',
  )
    .bind(roomId, userId, Date.now())
    .run();
}

async function memberRole(env, roomId, userId) {
  const row = await env.DB.prepare(
    'SELECT role FROM room_members WHERE room_id = ? AND user_id = ?',
  )
    .bind(roomId, userId)
    .first();
  return row?.role ?? null;
}

async function listMembers(env, roomId) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.nickname, rm.joined_at AS joinedAt, rm.role AS role
     FROM room_members rm JOIN users u ON u.id = rm.user_id
     WHERE rm.room_id = ? ORDER BY rm.joined_at ASC`,
  )
    .bind(roomId)
    .all();
  return (rows.results ?? []).map((row) => ({ ...row, role: row.role ?? 'member' }));
}

async function canEnterRoom(env, room, user) {
  const member = await isMember(env, room.id, user.id);
  if (room.visibility === 'public') return { allowed: true, member };
  return { allowed: member, member };
}

async function areFriends(env, userId, friendId) {
  const row = await env.DB.prepare(
    'SELECT 1 AS ok FROM friends WHERE user_id = ? AND friend_id = ?',
  )
    .bind(userId, friendId)
    .first();
  return Boolean(row?.ok);
}

async function makeFriends(env, userId, friendId) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)')
      .bind(userId, friendId, now),
    env.DB.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)')
      .bind(friendId, userId, now),
  ]);
}

async function getChannel(env, channelId) {
  return env.DB.prepare(
    `SELECT id, room_id AS roomId, name, position, created_at AS createdAt
     FROM channels WHERE id = ?`,
  )
    .bind(channelId)
    .first();
}

async function listChannels(env, roomId) {
  const rows = await env.DB.prepare(
    `SELECT id, room_id AS roomId, name, position, created_at AS createdAt
     FROM channels WHERE room_id = ? ORDER BY position ASC, created_at ASC`,
  )
    .bind(roomId)
    .all();
  return (rows.results ?? []).map(mapChannel);
}

async function firstChannel(env, roomId) {
  const channels = await listChannels(env, roomId);
  if (channels.length) return channels[0];

  const channel = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 8),
    roomId,
    name: '일반',
    position: 0,
    createdAt: Date.now(),
  };
  await env.DB.prepare(
    'INSERT OR IGNORE INTO channels (id, room_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(channel.id, channel.roomId, channel.name, channel.position, channel.createdAt)
    .run();
  return (await getChannel(env, channel.id)) ?? channel;
}

async function listUnread(env, user, room) {
  const rows = await env.DB.prepare(
    `SELECT c.id AS channelId,
            COALESCE(r.read_at, MAX(c.created_at, COALESCE(rm.joined_at, c.created_at))) AS lastReadAt,
            (SELECT COUNT(*) FROM messages m
              WHERE m.channel_id = c.id
                AND m.user_id <> ?
                AND m.created_at > COALESCE(r.read_at, MAX(c.created_at, COALESCE(rm.joined_at, c.created_at)))
            ) AS unread
     FROM channels c
     LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?
     LEFT JOIN room_members rm ON rm.room_id = c.room_id AND rm.user_id = ?
     WHERE c.room_id = ?
     ORDER BY c.position ASC, c.created_at ASC`,
  )
    .bind(user.id, user.id, user.id, room.id)
    .all();
  return (rows.results ?? []).map((row) => ({
    channelId: row.channelId,
    unread: Number(row.unread) || 0,
    lastReadAt: Number(row.lastReadAt) || 0,
  }));
}

const rateBuckets = new Map();
function takeRateToken(userId) {
  if (rateBuckets.size > 5000) rateBuckets.clear();
  const now = Date.now();
  const bucket = rateBuckets.get(userId) ?? { tokens: 5, updatedAt: now };
  bucket.tokens = Math.min(5, bucket.tokens + (now - bucket.updatedAt) / 1200);
  bucket.updatedAt = now;
  rateBuckets.set(userId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/* ------------------------------------------------------------------ *
 * 실시간 (Sites REALTIME 바인딩)
 * ------------------------------------------------------------------ */

async function realtimeHub(env) {
  if (!env.REALTIME) return null;
  return env.REALTIME.get(env.REALTIME.idFromName('hub'));
}

async function publishRealtime(env, { room, event, data }) {
  const hub = await realtimeHub(env);
  if (!hub) return false;
  const response = await hub.fetch(
    new Request('https://realtime/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, event, data }),
    }),
  );
  return response.ok;
}

async function issueTicket(request, env, user) {
  if (!env.REALTIME) return fail('이 환경에서는 실시간이 비활성화되어 있어요.', 503);
  const body = await readJson(request);
  const room = String(body?.room ?? 'global');

  if (room !== 'global') {
    const channelMatch = REALTIME_CHANNEL_RE.exec(room);
    if (channelMatch) {
      const channel = await getChannel(env, channelMatch[1]);
      const target = channel ? await getRoom(env, channel.roomId) : null;
      if (!target) return fail('방을 찾을 수 없어요.', 404);
      const access = await canEnterRoom(env, target, user);
      if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);
    } else {
      const matched = REALTIME_ROOM_RE.exec(room);
      const target = matched ? await getRoom(env, matched[1]) : null;
      if (!target) return fail('방을 찾을 수 없어요.', 404);
      const access = await canEnterRoom(env, target, user);
      if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);
    }
  }

  const hub = await realtimeHub(env);
  const response = await hub.fetch(
    new Request('https://realtime/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room,
        userId: user.id,
        origin: env.APP_ORIGIN || new URL(request.url).origin,
        publish: false,
        presence: true,
      }),
    }),
  );

  if (!response.ok) return fail('실시간 티켓을 발급하지 못했어요.', 502);
  const ticket = await response.json();
  return json(ticket, 200, { 'Cache-Control': 'private, no-store' });
}

/* ------------------------------------------------------------------ *
 * 인증
 * ------------------------------------------------------------------ */

async function login(request, env) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const body = await readJson(request);
  const userId = String(body?.userId ?? '').trim();
  const nickname = String(body?.nickname ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);

  if (!USER_ID_RE.test(userId)) return fail('아이디는 영문·숫자·_ . - 로 3~20자로 정해 주세요.');
  if (!nickname) return fail('닉네임을 입력해 주세요.');

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, nickname, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nickname = excluded.nickname, last_seen_at = excluded.last_seen_at`,
  )
    .bind(userId, nickname, now, now)
    .run();

  const token = await createSession(env, userId);
  return json(
    { user: { id: userId, nickname } },
    200,
    { 'Set-Cookie': sessionCookie(token, { secure: new URL(request.url).protocol === 'https:' }) },
  );
}

async function logout(request) {
  return json(
    { ok: true },
    200,
    { 'Set-Cookie': clearedCookie({ secure: new URL(request.url).protocol === 'https:' }) },
  );
}

/* ------------------------------------------------------------------ *
 * 방
 * ------------------------------------------------------------------ */

async function listRooms(request, env, url, user) {
  const query = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
  const base = `SELECT r.id, r.name, r.description, r.owner_id AS ownerId, r.visibility,
                       r.created_at AS createdAt, r.last_activity_at AS lastActivityAt,
                       m.nickname AS lastNickname, m.text AS lastText, m.created_at AS lastCreatedAt,
                       EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.user_id = ?)
                         AS isMember
                FROM rooms r
                LEFT JOIN messages m ON m.id = (
                  SELECT id FROM messages WHERE room_id = r.id
                  ORDER BY created_at DESC, id DESC LIMIT 1
                )
                WHERE (r.visibility = 'public' OR EXISTS (
                  SELECT 1 FROM room_members rm2 WHERE rm2.room_id = r.id AND rm2.user_id = ?
                ))`;

  const rows = query
    ? await env.DB.prepare(
        `${base} AND (lower(r.name) LIKE ? OR lower(r.description) LIKE ?)
         ORDER BY r.last_activity_at DESC LIMIT 100`,
      )
        .bind(user.id, user.id, `%${query}%`, `%${query}%`)
        .all()
    : await env.DB.prepare(`${base} ORDER BY r.last_activity_at DESC LIMIT 100`)
        .bind(user.id, user.id)
        .all();

  const globalLast = await env.DB.prepare(
    `SELECT nickname, text, created_at AS createdAt FROM messages
     WHERE room_id IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).first();

  return json({
    rooms: (rows.results ?? []).map((row) => ({
      ...mapRoom(row),
      isMember: Boolean(row.isMember),
      isOwner: row.ownerId === user.id,
    })),
    global: {
      lastMessage: globalLast
        ? { nickname: globalLast.nickname, text: globalLast.text, createdAt: globalLast.createdAt }
        : null,
    },
  });
}

async function createRoom(request, env, user) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const body = await readJson(request);
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const description = String(body?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const visibility = VISIBILITIES.has(body?.visibility) ? body.visibility : 'public';
  if (name.length < 2) return fail('방 이름은 2자 이상으로 정해 주세요.');

  const now = Date.now();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
    const code = createRoomCode();
    try {
      await env.DB.prepare(
        `INSERT INTO rooms (id, name, description, owner_id, visibility, code, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, name, description, user.id, visibility, code, now, now)
        .run();
      await addMember(env, id, user.id);
      const channel = await firstChannel(env, id);
      return json(
        {
          room: {
            id,
            name,
            description,
            ownerId: user.id,
            visibility,
            code,
            createdAt: now,
            lastActivityAt: now,
            lastMessage: null,
          },
          channels: await listChannels(env, id),
          channel,
          members: await listMembers(env, id),
        },
        201,
      );
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }
  return fail('방을 만들지 못했어요.', 500);
}

async function getRoomDetail(request, env, user, roomId) {
  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);

  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);

  const isOwner = room.ownerId === user.id;
  const isAdmin = !isOwner && (await memberRole(env, room.id, user.id)) === 'admin';
  return json({
    room: mapRoom(room, { includeCode: isOwner }),
    channels: await listChannels(env, room.id),
    members: await listMembers(env, room.id),
    isOwner,
    isMember: access.member,
    isAdmin,
    canModerate: isOwner || isAdmin,
    canManageChannels: isOwner || isAdmin,
  });
}

async function setMemberRole(request, env, user, roomId, targetId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 권한을 바꿀 수 있어요.', 403);
  if (targetId === room.ownerId) return fail('방장의 권한은 바꿀 수 없어요.');
  if (!(await isMember(env, room.id, targetId))) {
    return fail('방 참여자에게만 권한을 줄 수 있어요.', 404);
  }

  const body = await readJson(request);
  const role = body?.role === 'admin' ? 'admin' : body?.role === 'member' ? 'member' : null;
  if (!role) return fail('권한 값이 올바르지 않아요.');

  await env.DB.prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?')
    .bind(role, room.id, targetId)
    .run();

  await publishRealtime(env, {
    room: realtimeRoom(room.id),
    event: 'roles-changed',
    data: { roomId: room.id },
  }).catch(() => {});

  return json({ members: await listMembers(env, room.id) });
}

async function updateRoom(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 설정을 바꿀 수 있어요.', 403);

  const body = await readJson(request);
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const description = String(body?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const visibility = VISIBILITIES.has(body?.visibility) ? body.visibility : room.visibility;
  if (name.length < 2) return fail('방 이름은 2자 이상으로 정해 주세요.');

  await env.DB.prepare(
    'UPDATE rooms SET name = ?, description = ?, visibility = ? WHERE id = ?',
  )
    .bind(name, description, visibility, room.id)
    .run();

  const updated = await getRoom(env, room.id);
  return json({
    room: mapRoom(updated, { includeCode: true }),
    members: await listMembers(env, room.id),
    isOwner: true,
    isMember: true,
  });
}

async function joinRoomById(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);

  const member = await isMember(env, room.id, user.id);
  if (!member && room.visibility === 'private') {
    return fail('비공개 방이에요. 방장에게 초대를 요청해 주세요.', 403);
  }
  if (!member && room.visibility === 'invite') {
    return fail('초대가 필요한 방이에요. 방 코드나 초대 링크로 입장해 주세요.', 403);
  }
  if (!member) await addMember(env, room.id, user.id);

  return json({
    room: mapRoom(room, { includeCode: room.ownerId === user.id }),
    isOwner: room.ownerId === user.id,
  });
}

async function joinRoomByCode(request, env, user) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const body = await readJson(request);
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return fail('방 코드를 확인해 주세요.');

  const room = await env.DB.prepare(
    `SELECT id, name, description, owner_id AS ownerId, visibility, code,
            created_at AS createdAt, last_activity_at AS lastActivityAt
     FROM rooms WHERE code = ?`,
  )
    .bind(code)
    .first();
  if (!room) return fail('코드에 맞는 방이 없어요.', 404);

  const member = await isMember(env, room.id, user.id);
  if (!member && room.visibility === 'private') {
    return fail('비공개 방이에요. 방장에게 초대를 요청해 주세요.', 403);
  }
  if (!member) await addMember(env, room.id, user.id);

  return json({
    room: mapRoom(room, { includeCode: room.ownerId === user.id }),
    isOwner: room.ownerId === user.id,
  });
}

async function addRoomMember(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 초대할 수 있어요.', 403);

  const body = await readJson(request);
  const targetId = String(body?.userId ?? '').trim();
  if (!targetId) return fail('초대할 친구를 선택해 주세요.');

  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return fail('해당 아이디의 사용자가 없어요.', 404);
  if (!(await areFriends(env, user.id, targetId))) {
    return fail('친구만 초대할 수 있어요. 먼저 친구를 추가해 주세요.', 403);
  }

  await addMember(env, room.id, targetId);
  return json({ members: await listMembers(env, room.id) });
}

async function removeRoomMember(request, env, user, roomId, targetId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 내보낼 수 있어요.', 403);
  if (targetId === room.ownerId) return fail('방장은 내보낼 수 없어요.');

  await env.DB.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
    .bind(room.id, targetId)
    .run();
  return json({ members: await listMembers(env, room.id) });
}

async function transferRoomOwner(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 방장을 넘길 수 있어요.', 403);

  const body = await readJson(request);
  const targetId = String(body?.userId ?? '').trim();
  if (!targetId) return fail('방장을 넘길 참여자를 선택해 주세요.');
  if (targetId === room.ownerId) return fail('이미 방장이에요.');
  if (!(await isMember(env, room.id, targetId))) {
    return fail('방에 참여 중인 사람에게만 넘길 수 있어요.');
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?').bind(targetId, room.id),
    env.DB.prepare("UPDATE room_members SET role = 'member' WHERE room_id = ? AND user_id = ?")
      .bind(room.id, room.ownerId),
  ]);

  await publishRealtime(env, {
    room: realtimeRoom(room.id),
    event: 'owner-changed',
    data: { roomId: room.id, ownerId: targetId },
  }).catch(() => {});

  const updated = await getRoom(env, room.id);
  const isOwner = updated.ownerId === user.id;
  return json({
    room: mapRoom(updated, { includeCode: isOwner }),
    members: await listMembers(env, room.id),
    isOwner,
    isMember: await isMember(env, room.id, user.id),
  });
}

async function createChannel(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const isAdmin = (await memberRole(env, room.id, user.id)) === 'admin';
  if (room.ownerId !== user.id && !isAdmin) {
    return fail('방장이나 관리자만 채널을 만들 수 있어요.', 403);
  }

  const body = await readJson(request);
  const name = String(body?.name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  if (!name) return fail('채널 이름을 입력해 주세요.');

  const channels = await listChannels(env, room.id);
  const channel = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 8),
    roomId: room.id,
    name,
    position: channels.length,
    createdAt: Date.now(),
  };

  try {
    await env.DB.prepare(
      'INSERT INTO channels (id, room_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(channel.id, channel.roomId, channel.name, channel.position, channel.createdAt)
      .run();
  } catch {
    return fail('같은 이름의 채널이 이미 있어요.', 409);
  }

  return json({ channels: await listChannels(env, room.id), channel }, 201);
}

async function getUnread(env, user, roomId) {
  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);
  return json({ channels: await listUnread(env, user, room) });
}

async function markChannelRead(request, env, user, channelId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const channel = await getChannel(env, channelId);
  if (!channel) return fail('채널을 찾을 수 없어요.', 404);
  const room = await getRoom(env, channel.roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);

  const readAt = Math.max(Date.now(), channel.createdAt);
  await env.DB.prepare(
    `INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = excluded.read_at`,
  )
    .bind(user.id, channel.id, readAt)
    .run();

  return json({ ok: true, channelId: channel.id, readAt });
}

async function listPositions(env, user, room) {
  const rows = await env.DB.prepare(
    `SELECT cp.channel_id AS channelId, cp.scroll_top AS scrollTop
     FROM channel_positions cp JOIN channels c ON c.id = cp.channel_id
     WHERE cp.user_id = ? AND c.room_id = ?`,
  )
    .bind(user.id, room.id)
    .all();
  return (rows.results ?? []).map((row) => ({
    channelId: row.channelId,
    scrollTop: Number(row.scrollTop) || 0,
  }));
}

async function getPositions(env, user, roomId) {
  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);
  return json({ positions: await listPositions(env, user, room) });
}

async function savePosition(request, env, user, channelId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const channel = await getChannel(env, channelId);
  if (!channel) return fail('채널을 찾을 수 없어요.', 404);
  const room = await getRoom(env, channel.roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return fail('초대가 필요한 방이에요.', 403);

  const body = await readJson(request);
  const scrollTop = Math.max(0, Math.min(5_000_000, Math.round(Number(body?.scrollTop) || 0)));

  await env.DB.prepare(
    `INSERT INTO channel_positions (user_id, channel_id, scroll_top, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       scroll_top = excluded.scroll_top, updated_at = excluded.updated_at`,
  )
    .bind(user.id, channel.id, scrollTop, Date.now())
    .run();

  return json({ ok: true, channelId: channel.id, scrollTop });
}

async function deleteChannel(request, env, user, channelId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const channel = await getChannel(env, channelId);
  if (!channel) return fail('채널을 찾을 수 없어요.', 404);
  const room = await getRoom(env, channel.roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  const isAdmin = (await memberRole(env, room.id, user.id)) === 'admin';
  if (room.ownerId !== user.id && !isAdmin) {
    return fail('방장이나 관리자만 채널을 삭제할 수 있어요.', 403);
  }

  const channels = await listChannels(env, room.id);
  if (channels.length <= 1) return fail('마지막 채널은 삭제할 수 없어요.');

  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE channel_id = ?').bind(channel.id),
    env.DB.prepare('DELETE FROM channel_reads WHERE channel_id = ?').bind(channel.id),
    env.DB.prepare('DELETE FROM channel_positions WHERE channel_id = ?').bind(channel.id),
    env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channel.id),
  ]);

  await publishRealtime(env, {
    room: `ch:${channel.id}`,
    event: 'channel-deleted',
    data: { channelId: channel.id, roomId: room.id },
  }).catch(() => {});

  return json({ channels: await listChannels(env, room.id) });
}

async function deleteRoom(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 방을 삭제할 수 있어요.', 403);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE room_id = ?').bind(room.id),
    env.DB.prepare('DELETE FROM room_members WHERE room_id = ?').bind(room.id),
    env.DB.prepare('DELETE FROM moderation_log WHERE room_id = ?').bind(room.id),
    env.DB.prepare(
      'DELETE FROM channel_reads WHERE channel_id IN (SELECT id FROM channels WHERE room_id = ?)',
    ).bind(room.id),
    env.DB.prepare(
      'DELETE FROM channel_positions WHERE channel_id IN (SELECT id FROM channels WHERE room_id = ?)',
    ).bind(room.id),
    env.DB.prepare('DELETE FROM channels WHERE room_id = ?').bind(room.id),
    env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(room.id),
  ]);

  await publishRealtime(env, {
    room: realtimeRoom(room.id),
    event: 'room-deleted',
    data: { roomId: room.id },
  }).catch(() => {});

  return json({ ok: true });
}

async function leaveRoom(request, env, user, roomId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId === user.id) {
    return fail('방장은 방을 나갈 수 없어요. 방을 삭제해 주세요.');
  }
  if (!(await isMember(env, room.id, user.id))) {
    return fail('참여 중인 방이 아니에요.');
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').bind(
      room.id,
      user.id,
    ),
    env.DB.prepare(
      'DELETE FROM channel_reads WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE room_id = ?)',
    ).bind(user.id, room.id),
    env.DB.prepare(
      'DELETE FROM channel_positions WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE room_id = ?)',
    ).bind(user.id, room.id),
  ]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * 메시지
 * ------------------------------------------------------------------ */

async function resolveMessageScope(env, user, { roomId, channelId }) {
  if (!roomId) return { room: null, channel: null };

  const room = await getRoom(env, roomId);
  if (!room) return { error: fail('방을 찾을 수 없어요.', 404) };
  const access = await canEnterRoom(env, room, user);
  if (!access.allowed) return { error: fail('초대가 필요한 방이에요.', 403) };

  const channel = channelId ? await getChannel(env, channelId) : await firstChannel(env, room.id);
  if (!channel || channel.roomId !== room.id) {
    return { error: fail('채널을 찾을 수 없어요.', 404) };
  }
  return { room, channel };
}

async function listMessages(request, env, url, user) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || HISTORY_LIMIT));
  const after = Number(url.searchParams.get('after'));
  const afterId = String(url.searchParams.get('afterId') ?? '');

  const legacy = String(url.searchParams.get('channel') ?? 'global');
  const roomParam = url.searchParams.get('room');
  const channelParam = url.searchParams.get('channelId');
  const targetRoom =
    roomParam && roomParam !== 'global' ? String(roomParam) : legacy !== 'global' ? legacy : null;

  const scope = await resolveMessageScope(env, user, {
    roomId: targetRoom,
    channelId: channelParam ? String(channelParam) : null,
  });
  if (scope.error) return scope.error;

  const channel = scope.channel;
  const where = channel ? 'channel_id = ?' : 'room_id IS NULL';
  const params = channel ? [channel.id] : [];
  const select = `SELECT id, room_id AS roomId, channel_id AS channelId, user_id AS userId,
                         nickname, text, created_at AS createdAt FROM messages`;

  if (Number.isFinite(after) && after > 0) {
    const rows = await env.DB.prepare(
      `${select} WHERE ${where} AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
      .bind(...params, after, after, afterId, limit)
      .all();
    return json({ messages: (rows.results ?? []).map(mapMessage), channel: roomId ?? 'global' });
  }

  const rows = await env.DB.prepare(
    `${select} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...params, limit)
    .all();

  return json({
    messages: (rows.results ?? []).map(mapMessage).reverse(),
    channel: channel?.id ?? 'global',
    roomId: scope.room?.id ?? null,
  });
}

async function postMessage(request, env, user) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);
  if (!takeRateToken(user.id)) {
    return fail('메시지를 너무 빠르게 보내고 있어요. 잠시만 기다려 주세요.', 429);
  }

  const body = await readJson(request);
  const text = String(body?.text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
  if (!text) return fail('빈 메시지는 보낼 수 없어요.');

  const requestedRoom = body?.roomId ? String(body.roomId) : null;
  const requestedChannel = body?.channelId ? String(body.channelId) : null;

  const scope = await resolveMessageScope(env, user, {
    roomId: requestedRoom,
    channelId: requestedChannel,
  });
  if (scope.error) return scope.error;

  const roomId = scope.room?.id ?? null;
  const channel = scope.channel;

  const message = {
    id: crypto.randomUUID(),
    roomId,
    channelId: channel?.id ?? null,
    userId: user.id,
    nickname: user.nickname,
    text,
    createdAt: Date.now(),
  };

  await env.DB.prepare(
    `INSERT INTO messages (id, room_id, channel_id, user_id, nickname, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      message.id,
      message.roomId,
      message.channelId,
      message.userId,
      message.nickname,
      message.text,
      message.createdAt,
    )
    .run();

  if (roomId) {
    await env.DB.prepare('UPDATE rooms SET last_activity_at = ? WHERE id = ?')
      .bind(message.createdAt, roomId)
      .run();
  }

  if (roomId && channel) {
    // 내가 보낸 메시지까지는 읽은 것으로 본다(내 글 앞에 구분선이 생기지 않도록).
    await env.DB.prepare(
      `INSERT INTO channel_reads (user_id, channel_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET read_at = MAX(channel_reads.read_at, excluded.read_at)`,
    )
      .bind(user.id, channel.id, message.createdAt)
      .run();
  }

  const publishes = [
    publishRealtime(env, {
      room: channel ? `ch:${channel.id}` : 'global',
      event: 'message',
      data: message,
    }),
  ];
  if (roomId && channel) {
    // 구독 중이 아닌 채널의 배지를 즉시 올리기 위한 가벼운 알림(본문 미포함).
    publishes.push(
      publishRealtime(env, {
        room: realtimeRoom(roomId),
        event: 'channel-message',
        data: {
          roomId,
          channelId: channel.id,
          messageId: message.id,
          userId: message.userId,
          nickname: message.nickname,
          createdAt: message.createdAt,
        },
      }),
    );
  }
  await Promise.all(publishes).catch(() => {});

  return json({ message }, 201);
}

async function listModerationLog(request, env, user, roomId) {
  const room = await getRoom(env, roomId);
  if (!room) return fail('방을 찾을 수 없어요.', 404);
  if (room.ownerId !== user.id) return fail('방장만 삭제 기록을 볼 수 있어요.', 403);

  const rows = await env.DB.prepare(
    `SELECT id, actor_id AS actorId, actor_nickname AS actorNickname,
            author_id AS authorId, author_nickname AS authorNickname,
            message_id AS messageId, message_text AS messageText, created_at AS createdAt
     FROM moderation_log WHERE room_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(room.id)
    .all();

  return json({ entries: rows.results ?? [] }, 200, { 'Cache-Control': 'private, no-store' });
}

async function deleteMessage(request, env, user, messageId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const message = await env.DB.prepare(
    `SELECT id, room_id AS roomId, user_id AS userId, nickname, text
     FROM messages WHERE id = ?`,
  )
    .bind(messageId)
    .first();
  if (!message) return fail('메시지를 찾을 수 없어요.', 404);

  let moderated = false;
  if (message.userId !== user.id) {
    if (!message.roomId) return fail('내 메시지만 삭제할 수 있어요.', 403);
    const room = await getRoom(env, message.roomId);
    if (!room) return fail('방을 찾을 수 없어요.', 404);
    const allowed =
      room.ownerId === user.id || (await memberRole(env, room.id, user.id)) === 'admin';
    if (!allowed) return fail('메시지를 삭제할 권한이 없어요.', 403);
    moderated = true;
  }

  const statements = [env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(message.id)];
  if (moderated) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO moderation_log (id, room_id, actor_id, actor_nickname,
                                     author_id, author_nickname, message_id, message_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        message.roomId,
        user.id,
        user.nickname,
        message.userId,
        message.nickname,
        message.id,
        String(message.text).slice(0, 300),
        Date.now(),
      ),
    );
  }

  await env.DB.batch(statements);

  await publishRealtime(env, {
    room: realtimeRoom(message.roomId),
    event: 'message-deleted',
    data: { id: message.id, roomId: message.roomId },
  }).catch(() => {});

  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * 친구
 * ------------------------------------------------------------------ */

async function listFriends(env, user) {
  const [friends, incoming, outgoing] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.nickname FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.nickname ASC`,
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      `SELECT r.id, r.from_id AS userId, u.nickname, r.created_at AS createdAt
       FROM friend_requests r JOIN users u ON u.id = r.from_id
       WHERE r.to_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      `SELECT r.id, r.to_id AS userId, u.nickname, r.created_at AS createdAt
       FROM friend_requests r JOIN users u ON u.id = r.to_id
       WHERE r.from_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC`,
    )
      .bind(user.id)
      .all(),
  ]);

  return json({
    friends: friends.results ?? [],
    incoming: incoming.results ?? [],
    outgoing: outgoing.results ?? [],
  });
}

async function requestFriend(request, env, user) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const body = await readJson(request);
  const targetId = String(body?.userId ?? '').trim();
  if (!USER_ID_RE.test(targetId)) return fail('친구 아이디를 확인해 주세요.');
  if (targetId === user.id) return fail('자기 자신은 추가할 수 없어요.');

  const target = await env.DB.prepare('SELECT id, nickname FROM users WHERE id = ?')
    .bind(targetId)
    .first();
  if (!target) return fail('해당 아이디의 사용자가 없어요.', 404);
  if (await areFriends(env, user.id, targetId)) return fail('이미 친구예요.', 409);

  const reverse = await env.DB.prepare(
    `SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'`,
  )
    .bind(targetId, user.id)
    .first();

  if (reverse) {
    await makeFriends(env, user.id, targetId);
    await env.DB.prepare(
      `UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), reverse.id)
      .run();
    return json({ status: 'accepted', friend: target });
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'`,
  )
    .bind(user.id, targetId)
    .first();
  if (existing) return fail('이미 친구 요청을 보냈어요.', 409);

  await env.DB.prepare(
    `INSERT INTO friend_requests (id, from_id, to_id, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  )
    .bind(crypto.randomUUID(), user.id, targetId, Date.now())
    .run();

  return json({ status: 'requested', friend: target }, 201);
}

async function respondFriendRequest(request, env, user, requestId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  const body = await readJson(request);
  const action = String(body?.action ?? '');
  const row = await env.DB.prepare(
    `SELECT id, from_id AS fromId, to_id AS toId FROM friend_requests
     WHERE id = ? AND to_id = ? AND status = 'pending'`,
  )
    .bind(requestId, user.id)
    .first();
  if (!row) return fail('처리할 요청을 찾을 수 없어요.', 404);

  if (action === 'accept') {
    await makeFriends(env, row.fromId, row.toId);
    await env.DB.prepare(
      `UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), row.id)
      .run();
    return json({ ok: true });
  }

  if (action === 'decline') {
    await env.DB.prepare(
      `UPDATE friend_requests SET status = 'declined', responded_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), row.id)
      .run();
    return json({ ok: true });
  }

  return fail('잘못된 요청이에요.');
}

async function removeFriend(request, env, user, friendId) {
  if (!sameOrigin(request, env)) return fail('허용되지 않은 요청이에요.', 403);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?')
      .bind(user.id, friendId),
    env.DB.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?')
      .bind(friendId, user.id),
  ]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * 라우터
 * ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  await ensureSchema(env);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login') {
    return method === 'POST' ? login(request, env) : fail('허용되지 않은 메서드예요.', 405);
  }
  if (path === '/api/logout') {
    return method === 'POST' ? logout(request) : fail('허용되지 않은 메서드예요.', 405);
  }

  const user = await currentUser(env, request);
  if (!user) return fail('로그인이 필요해요.', 401);

  if (path === '/api/me') {
    return method === 'GET' ? json({ user }) : fail('허용되지 않은 메서드예요.', 405);
  }

  if (path === '/api/rooms') {
    if (method === 'GET') return listRooms(request, env, url, user);
    if (method === 'POST') return createRoom(request, env, user);
    return fail('허용되지 않은 메서드예요.', 405);
  }
  if (path === '/api/rooms/join') {
    return method === 'POST' ? joinRoomByCode(request, env, user) : fail('허용되지 않은 메서드예요.', 405);
  }

  if (path === '/api/messages') {
    if (method === 'GET') return listMessages(request, env, url, user);
    if (method === 'POST') return postMessage(request, env, user);
    return fail('허용되지 않은 메서드예요.', 405);
  }
  if (path === '/api/realtime/ticket') {
    return method === 'POST' ? issueTicket(request, env, user) : fail('허용되지 않은 메서드예요.', 405);
  }

  if (path === '/api/friends') {
    return method === 'GET' ? listFriends(env, user) : fail('허용되지 않은 메서드예요.', 405);
  }
  if (path === '/api/friends/requests') {
    return method === 'POST' ? requestFriend(request, env, user) : fail('허용되지 않은 메서드예요.', 405);
  }

  const respondMatch = /^\/api\/friends\/requests\/([^/]+)\/respond$/.exec(path);
  if (respondMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return respondFriendRequest(request, env, user, decodeSegment(respondMatch[1]));
  }

  const friendMatch = /^\/api\/friends\/([^/]+)$/.exec(path);
  if (friendMatch) {
    if (method !== 'DELETE') return fail('허용되지 않은 메서드예요.', 405);
    return removeFriend(request, env, user, decodeSegment(friendMatch[1]));
  }

  const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
  if (joinMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return joinRoomById(request, env, user, decodeSegment(joinMatch[1]));
  }

  const membersMatch = /^\/api\/rooms\/([^/]+)\/members$/.exec(path);
  if (membersMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return addRoomMember(request, env, user, decodeSegment(membersMatch[1]));
  }

  const memberMatch = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/.exec(path);
  if (memberMatch) {
    if (method !== 'DELETE') return fail('허용되지 않은 메서드예요.', 405);
    return removeRoomMember(
      request,
      env,
      user,
      decodeSegment(memberMatch[1]),
      decodeSegment(memberMatch[2]),
    );
  }

  const positionsMatch = /^\/api\/rooms\/([^/]+)\/positions$/.exec(path);
  if (positionsMatch) {
    if (method !== 'GET') return fail('허용되지 않은 메서드예요.', 405);
    return getPositions(env, user, decodeSegment(positionsMatch[1]));
  }

  const unreadMatch = /^\/api\/rooms\/([^/]+)\/unread$/.exec(path);
  if (unreadMatch) {
    if (method !== 'GET') return fail('허용되지 않은 메서드예요.', 405);
    return getUnread(env, user, decodeSegment(unreadMatch[1]));
  }

  const channelsMatch = /^\/api\/rooms\/([^/]+)\/channels$/.exec(path);
  if (channelsMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return createChannel(request, env, user, decodeSegment(channelsMatch[1]));
  }

  const channelPositionMatch = /^\/api\/channels\/([^/]+)\/position$/.exec(path);
  if (channelPositionMatch) {
    if (method !== 'PUT') return fail('허용되지 않은 메서드예요.', 405);
    return savePosition(request, env, user, decodeSegment(channelPositionMatch[1]));
  }

  const channelReadMatch = /^\/api\/channels\/([^/]+)\/read$/.exec(path);
  if (channelReadMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return markChannelRead(request, env, user, decodeSegment(channelReadMatch[1]));
  }

  const channelMatch = /^\/api\/channels\/([^/]+)$/.exec(path);
  if (channelMatch) {
    if (method !== 'DELETE') return fail('허용되지 않은 메서드예요.', 405);
    return deleteChannel(request, env, user, decodeSegment(channelMatch[1]));
  }

  const moderationMatch = /^\/api\/rooms\/([^/]+)\/moderation$/.exec(path);
  if (moderationMatch) {
    if (method !== 'GET') return fail('허용되지 않은 메서드예요.', 405);
    return listModerationLog(request, env, user, decodeSegment(moderationMatch[1]));
  }

  const roleMatch = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)\/role$/.exec(path);
  if (roleMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return setMemberRole(
      request,
      env,
      user,
      decodeSegment(roleMatch[1]),
      decodeSegment(roleMatch[2]),
    );
  }

  const messageDeleteMatch = /^\/api\/messages\/([^/]+)$/.exec(path);
  if (messageDeleteMatch) {
    if (method !== 'DELETE') return fail('허용되지 않은 메서드예요.', 405);
    return deleteMessage(request, env, user, decodeSegment(messageDeleteMatch[1]));
  }

  const leaveMatch = /^\/api\/rooms\/([^/]+)\/leave$/.exec(path);
  if (leaveMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return leaveRoom(request, env, user, decodeSegment(leaveMatch[1]));
  }

  const ownerMatch = /^\/api\/rooms\/([^/]+)\/owner$/.exec(path);
  if (ownerMatch) {
    if (method !== 'POST') return fail('허용되지 않은 메서드예요.', 405);
    return transferRoomOwner(request, env, user, decodeSegment(ownerMatch[1]));
  }

  const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (roomMatch) {
    const roomId = decodeSegment(roomMatch[1]);
    if (method === 'GET') return getRoomDetail(request, env, user, roomId);
    if (method === 'PATCH') return updateRoom(request, env, user, roomId);
    if (method === 'DELETE') return deleteRoom(request, env, user, roomId);
    return fail('허용되지 않은 메서드예요.', 405);
  }

  return fail('없는 경로예요.', 404);
}

/* ------------------------------------------------------------------ *
 * 진입점
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/healthz') return json({ ok: true });
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);

      const asset = await env.ASSETS.fetch(request);
      if (
        asset.status === 404 &&
        request.method === 'GET' &&
        (request.headers.get('Accept') ?? '').includes('text/html')
      ) {
        return env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: 'GET' }));
      }
      return asset;
    } catch (error) {
      console.error('[linkchat]', error?.stack ?? error);
      return fail('서버 오류가 발생했어요.', 500);
    }
  },
};
