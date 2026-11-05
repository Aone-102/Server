import { connectRealtime } from './realtime.js';
import { createVoice } from './voice.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  themeToggle: $('#theme-toggle'),
  loginView: $('#login-view'),
  loginForm: $('#login-form'),
  loginId: $('#login-id'),
  loginNickname: $('#login-nickname'),
  loginError: $('#login-error'),
  loginSubmit: $('#login-submit'),
  appView: $('#app-view'),
  meAvatar: $('#me-avatar'),
  meNickname: $('#me-nickname'),
  meId: $('#me-id'),
  roomSearch: $('#room-search'),
  createRoomBtn: $('#create-room-btn'),
  joinCodeBtn: $('#join-code-btn'),
  friendsBtn: $('#friends-btn'),
  friendBadge: $('#friend-badge'),
  roomList: $('#room-list'),
  channelSection: $('#channel-section'),
  channelList: $('#channel-list'),
  createChannelBtn: $('#create-channel-btn'),
  channelDialog: $('#channel-dialog'),
  channelForm: $('#channel-form'),
  channelName: $('#channel-name'),
  channelError: $('#channel-error'),
  cancelChannelBtn: $('#cancel-channel-btn'),
  onlineCount: $('#online-count'),
  logoutBtn: $('#logout-btn'),
  backBtn: $('#back-btn'),
  chatTitle: $('#chat-title'),
  chatSub: $('#chat-sub'),
  settingsBtn: $('#settings-btn'),
  leaveBtn: $('#leave-btn'),
  inviteBtn: $('#invite-btn'),
  messages: $('#messages'),
  composer: $('#composer'),
  messageInput: $('#message-input'),
  createRoomDialog: $('#create-room-dialog'),
  createRoomForm: $('#create-room-form'),
  roomName: $('#room-name'),
  roomDesc: $('#room-desc'),
  createRoomError: $('#create-room-error'),
  cancelRoomBtn: $('#cancel-room-btn'),
  settingsDialog: $('#settings-dialog'),
  settingsForm: $('#settings-form'),
  settingsName: $('#settings-name'),
  settingsDesc: $('#settings-desc'),
  roomCode: $('#room-code'),
  copyCodeBtn: $('#copy-code-btn'),
  inviteFriendList: $('#invite-friend-list'),
  inviteFriendCount: $('#invite-friend-count'),
  memberList: $('#member-list'),
  memberCount: $('#member-count'),
  moderationList: $('#moderation-list'),
  moderationCount: $('#moderation-count'),
  deleteRoomBtn: $('#delete-room-btn'),
  settingsError: $('#settings-error'),
  closeSettingsBtn: $('#close-settings-btn'),
  friendsDialog: $('#friends-dialog'),
  addFriendForm: $('#add-friend-form'),
  friendId: $('#friend-id'),
  friendsError: $('#friends-error'),
  incomingList: $('#incoming-list'),
  incomingCount: $('#incoming-count'),
  outgoingList: $('#outgoing-list'),
  outgoingCount: $('#outgoing-count'),
  friendList: $('#friend-list'),
  friendCount: $('#friend-count'),
  closeFriendsBtn: $('#close-friends-btn'),
  joinDialog: $('#join-dialog'),
  joinForm: $('#join-form'),
  joinCode: $('#join-code'),
  joinError: $('#join-error'),
  closeJoinBtn: $('#close-join-btn'),
  confirmDialog: $('#confirm-dialog'),
  confirmTitle: $('#confirm-title'),
  confirmText: $('#confirm-text'),
  confirmOk: $('#confirm-ok'),
  confirmCancel: $('#confirm-cancel'),
  toast: $('#toast'),
  zoomOut: $('#zoom-out'),
  zoomIn: $('#zoom-in'),
  zoomLevel: $('#zoom-level'),
  voiceBtn: $('#voice-btn'),
  voicePanel: $('#voice-panel'),
  voiceTiles: $('#voice-tiles'),
  voiceStatus: $('#voice-status'),
  voiceMic: $('#voice-mic'),
  voiceScreen: $('#voice-screen'),
  voiceLeave: $('#voice-leave'),
  voiceClose: $('#voice-close'),
  voiceZoomIn: $('#voice-zoom-in'),
  voiceZoomOut: $('#voice-zoom-out'),
};

const THEME_KEY = 'lc-theme';
const SCROLL_STORE_PREFIX = 'lc-scroll:';
const VISIBILITY_LABEL = { public: '공개방', invite: '친구 초대방', private: '비공개방' };
const VISIBILITY_BADGE = { invite: '초대', private: '비공개' };

const state = {
  me: null,
  rooms: [],
  global: { lastMessage: null },
  channel: 'global',
  channels: [],
  channelId: null,
  unread: {},
  lastRead: {},
  pendingScroll: null,
  dividerMessageId: null,
  scrollPositions: {},
  messages: [],
  seen: new Set(),
  roomUsers: [],
  filter: '',
  realtime: null,
  realtimeReady: false,
  unreadRealtime: null,
  unreadRoom: null,
  room: null,
  isOwner: false,
  isMember: false,
  friends: { friends: [], incoming: [], outgoing: [] },
  settingsMembers: [],
  settingsFriends: [],
  voice: null,
  chatZoom: 1,
  voiceZoom: 1,
};

try {
  const savedZoom = Number(localStorage.getItem('lc-zoom'));
  if (Number.isFinite(savedZoom) && savedZoom >= 0.85 && savedZoom <= 1.6) state.chatZoom = savedZoom;
} catch {
  // 저장소를 쓸 수 없으면 기본 배율로 둔다.
}

const timeFormatter = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

/* ---------------------------------------------------------------- 유틸 */

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? `요청에 실패했어요 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function hueFor(value) {
  let hash = 7;
  for (const char of String(value)) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return hash;
}

function oneLine(text, limit = 48) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function isSameDay(a, b) {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function isNearBottom() {
  return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140;
}

function scrollToBottom(behavior = 'auto') {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior });
}

function scrollKey(channel = state.channel, channelId = state.channelId) {
  if (channel === 'global') return 'global';
  return channelId ? `${channel}:${channelId}` : channel;
}

function loadScrollPositions() {
  state.scrollPositions = {};
  if (!state.me?.id) return;
  try {
    const raw = localStorage.getItem(`${SCROLL_STORE_PREFIX}${state.me.id}`);
    if (!raw) return;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return;
    const next = {};
    for (const [key, value] of Object.entries(stored)) {
      const top = Number(value);
      if (Number.isFinite(top) && top > 0) next[key] = top;
    }
    state.scrollPositions = next;
  } catch {
    state.scrollPositions = {};
  }
}

function persistScrollPositions() {
  if (!state.me?.id) return;
  try {
    const entries = Object.entries(state.scrollPositions);
    if (entries.length > 150) {
      state.scrollPositions = Object.fromEntries(entries.slice(entries.length - 150));
    }
    localStorage.setItem(
      `${SCROLL_STORE_PREFIX}${state.me.id}`,
      JSON.stringify(state.scrollPositions),
    );
  } catch {
    // 저장 공간을 쓸 수 없는 브라우저에서는 현재 탭에서만 기억한다.
  }
}

function pushScrollPosition(channelId, scrollTop) {
  api(`/api/channels/${encodeURIComponent(channelId)}/position`, {
    method: 'PUT',
    body: JSON.stringify({ scrollTop: Math.round(scrollTop) }),
  }).catch(() => {
    // 서버에 못 보내도 브라우저에는 남아 있다.
  });
}

function saveScrollPosition() {
  if (!els.messages) return;
  const top = els.messages.scrollTop;
  state.scrollPositions[scrollKey()] = top;
  persistScrollPositions();
  if (state.channel !== 'global' && state.channelId) pushScrollPosition(state.channelId, top);
}

async function loadServerPositions() {
  if (state.channel === 'global') return;
  const room = state.channel;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(room)}/positions`);
    if (state.channel !== room) return;
    for (const item of data.positions ?? []) {
      const top = Number(item.scrollTop);
      if (Number.isFinite(top) && top > 0) {
        state.scrollPositions[`${room}:${item.channelId}`] = top;
      }
    }
    persistScrollPositions();
  } catch {
    // 서버 위치를 못 받으면 브라우저에 저장된 위치를 쓴다.
  }
}

let scrollSaveTimer = null;
els.messages.addEventListener(
  'scroll',
  () => {
    if (scrollSaveTimer) return;
    scrollSaveTimer = setTimeout(() => {
      scrollSaveTimer = null;
      saveScrollPosition();
    }, 500);
  },
  { passive: true },
);

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('toast--visible'), 2600);
}

function makeAvatar(nickname) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = String(nickname).trim().slice(0, 1).toUpperCase();
  avatar.style.setProperty('--avatar-hue', String(hueFor(nickname)));
  return avatar;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했어요');
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand?.('copy');
    helper.remove();
    toast(copied ? '복사했어요' : text);
  }
}

/* ---------------------------------------------------------------- 테마 */

function initTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  els.themeToggle.setAttribute('aria-pressed', String(current === 'dark'));

  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 저장할 수 없는 환경에서는 이번 세션에만 적용한다.
    }
    els.themeToggle.setAttribute('aria-pressed', String(next === 'dark'));
  });
}

/* ---------------------------------------------------------------- 목록 / 헤더 */

function listLabel(text) {
  const label = document.createElement('p');
  label.className = 'room-list__label';
  label.textContent = text;
  return label;
}

function personRow({ id, nickname, action, actions, badge }) {
  const row = document.createElement('div');
  row.className = 'person';
  row.append(makeAvatar(nickname));

  const text = document.createElement('div');
  text.className = 'person__text';
  const name = document.createElement('span');
  name.className = 'person__name';
  name.textContent = nickname;
  const handle = document.createElement('span');
  handle.className = 'person__id';
  handle.textContent = `@${id}`;
  const line = document.createElement('span');
  line.className = 'person__line';
  line.append(name);
  if (badge) {
    const tag = document.createElement('span');
    tag.className = 'person__badge';
    tag.textContent = badge;
    line.append(tag);
  }
  text.append(line, handle);
  row.append(text);

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.className ?? 'btn btn--ghost';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    row.append(button);
  }

  if (actions?.length) {
    const group = document.createElement('div');
    group.className = 'person__actions';
    for (const item of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.className ?? 'btn btn--ghost';
      button.textContent = item.label;
      button.addEventListener('click', item.onClick);
      group.append(button);
    }
    row.append(group);
  }

  return row;
}

function emptyNote(text) {
  const note = document.createElement('p');
  note.className = 'settings-list__empty';
  note.textContent = text;
  return note;
}

function roomItem({ id, name, description, last, visibility, active }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `room${active ? ' room--active' : ''}`;

  const head = document.createElement('div');
  head.className = 'room__head';

  const title = document.createElement('span');
  title.className = 'room__name';
  title.textContent = name;
  head.append(title);

  if (visibility && visibility !== 'public') {
    const badge = document.createElement('span');
    badge.className = 'room__meta';
    badge.textContent = VISIBILITY_BADGE[visibility] ?? '비공개';
    head.append(badge);
  }

  const preview = document.createElement('p');
  preview.className = 'room__preview';
  preview.textContent = last
    ? `${last.nickname}: ${oneLine(last.text)}`
    : description || '아직 메시지가 없어요';

  button.append(head, preview);
  button.addEventListener('click', () => openChannel(id));
  return button;
}

function renderRooms() {
  const fragment = document.createDocumentFragment();
  fragment.append(listLabel('채널'));
  fragment.append(
    roomItem({
      id: 'global',
      name: '글로벌 채팅',
      description: '모든 사람이 함께 이야기하는 곳',
      last: state.global.lastMessage,
      active: state.channel === 'global',
    }),
  );

  const query = state.filter.trim().toLowerCase();
  const rooms = state.rooms.filter(
    (room) => !query || `${room.name} ${room.description}`.toLowerCase().includes(query),
  );

  if (state.rooms.length) fragment.append(listLabel(`방 ${state.rooms.length}`));

  if (!rooms.length) {
    const empty = document.createElement('p');
    empty.className = 'room-list__empty';
    empty.textContent = query
      ? '검색 결과가 없어요.'
      : '아직 방이 없어요. + 버튼으로 첫 방을 만들어 보세요.';
    fragment.append(empty);
  }

  for (const room of rooms) {
    fragment.append(
      roomItem({
        id: room.id,
        name: room.name,
        description: room.description,
        last: room.lastMessage,
        visibility: room.visibility,
        active: state.channel === room.id,
      }),
    );
  }

  els.roomList.replaceChildren(fragment);
  renderChannels();
}

function renderChatHeader() {
  const room = state.rooms.find((item) => item.id === state.channel) ?? null;
  const isRoom = state.channel !== 'global';
  els.onlineCount.textContent = state.realtimeReady ? String(state.roomUsers.length) : '—';

  if (isRoom) {
    const detail = state.room?.room ?? null;
    const visibility = room?.visibility ?? detail?.visibility ?? 'public';
    const activeChannel = state.channels.find((item) => item.id === state.channelId) ?? null;
    const parts = [room?.name ?? detail?.name ?? '서버', VISIBILITY_LABEL[visibility] ?? '공개방'];
    if (state.realtimeReady) parts.push(`참여 중 ${state.roomUsers.length}명`);
    if (room?.description) parts.push(room.description);

    els.chatTitle.textContent = activeChannel
      ? `# ${activeChannel.name}`
      : room?.name ?? detail?.name ?? '방';
    els.chatSub.textContent = parts.join(' · ');
    els.settingsBtn.hidden = !state.isOwner;
    els.leaveBtn.hidden = state.isOwner || !state.isMember;
    els.inviteBtn.hidden = !(visibility === 'public' || state.isOwner);
    els.inviteBtn.textContent = visibility === 'public' ? '링크 복사' : '초대 링크';
    els.voiceBtn.hidden = false;
  } else {
    els.chatTitle.textContent = '글로벌 채팅';
    els.chatSub.textContent = state.realtimeReady
      ? `${state.roomUsers.length}명 참여 중 · 모든 사람과 함께 이야기해요`
      : '모든 사람과 함께 이야기해요';
    els.settingsBtn.hidden = true;
    els.leaveBtn.hidden = true;
    els.inviteBtn.hidden = false;
    els.inviteBtn.textContent = '링크 복사';
    els.voiceBtn.hidden = true;
  }
}

function applyChatZoom() {
  document.documentElement.style.setProperty('--chat-zoom', String(state.chatZoom));
  els.zoomLevel.textContent = `${Math.round(state.chatZoom * 100)}%`;
  try {
    localStorage.setItem('lc-zoom', String(state.chatZoom));
  } catch {
    // 저장 실패는 무시한다.
  }
}

function setChatZoom(next) {
  state.chatZoom = Math.min(1.6, Math.max(0.85, Math.round(next * 20) / 20));
  applyChatZoom();
}

function applyVoiceZoom() {
  els.voiceTiles.style.setProperty('--tile-zoom', String(state.voiceZoom));
}

function renderVoice() {
  const voice = state.voice;
  if (!voice) {
    els.voicePanel.hidden = true;
    els.voiceBtn.textContent = '음성';
    return;
  }

  const snap = voice.snapshot();
  els.voicePanel.hidden = false;
  els.voiceBtn.textContent = snap.joined ? `음성 ${snap.count}` : '음성';
  els.voiceStatus.textContent = snap.joined
    ? `${snap.statusLabel} · ${snap.count}명`
    : snap.statusLabel;
  els.voiceMic.textContent = snap.micOn ? '마이크 끄기' : '마이크 켜기';
  els.voiceMic.classList.toggle('is-off', !snap.micOn);
  els.voiceScreen.textContent = snap.screenOn ? '공유 중지' : '화면 공유';
  els.voiceScreen.disabled = !snap.canShareScreen;

  const fragment = document.createDocumentFragment();
  for (const person of snap.participants) {
    const tile = document.createElement('div');
    tile.className = `voice__tile${person.screen ? ' voice__tile--video' : ''}`;

    if (person.videoStream) {
      const video = document.createElement('video');
      video.className = 'voice__video';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = person.videoStream;
      tile.append(video);
      tile.addEventListener('dblclick', () => tile.classList.toggle('voice__tile--full'));
    } else {
      const avatar = document.createElement('span');
      avatar.className = 'voice__avatar';
      avatar.textContent = String(person.nickname).slice(0, 1).toUpperCase();
      tile.append(avatar);
    }

    const name = document.createElement('span');
    name.className = 'voice__name';
    name.textContent = `${person.nickname}${person.self ? ' (나)' : ''}`;
    tile.append(name);

    const flags = document.createElement('span');
    flags.className = 'voice__flags';
    flags.textContent = person.mic ? '🎙' : '🔇';
    tile.append(flags);
    fragment.append(tile);
  }

  if (!snap.participants.length) fragment.append(emptyNote('아직 아무도 없어요.'));
  els.voiceTiles.replaceChildren(fragment);
  applyVoiceZoom();
}

function openVoice() {
  if (state.channel === 'global') {
    toast('음성은 방 안에서만 쓸 수 있어요.');
    return Promise.resolve();
  }
  if (!state.voice) {
    state.voice = createVoice({
      roomId: state.channel,
      me: state.me,
      onState: () => renderVoice(),
      onNotice: (message) => toast(message),
    });
  }
  renderVoice();
  return state.voice.join().then(renderVoice);
}

async function closeVoice() {
  const voice = state.voice;
  if (!voice) return;
  state.voice = null;
  await voice.leave().catch(() => {});
  renderVoice();
}

function renderChannels() {
  const isRoom = state.channel !== 'global';
  els.channelSection.hidden = !isRoom;
  if (!isRoom) {
    els.channelList.replaceChildren();
    return;
  }

  const canManage = state.isOwner || state.isAdmin;
  els.createChannelBtn.hidden = !canManage;

  if (!state.channels.length) {
    els.channelList.replaceChildren(emptyNote('채널을 불러오는 중…'));
    return;
  }

  els.channelList.replaceChildren(
    ...state.channels.map((channel) => {
      const active = channel.id === state.channelId;
      const unread = active ? 0 : Math.max(0, Number(state.unread[channel.id]) || 0);
      const row = document.createElement('div');
      row.className = `channel${active ? ' channel--active' : ''}${unread ? ' channel--unread' : ''}`;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'channel__btn';
      button.textContent = `# ${channel.name}`;
      if (unread) {
        button.setAttribute('aria-label', `# ${channel.name}, 읽지 않음 ${unread}개`);
      }
      button.addEventListener('click', () => openChannel(state.channel, channel.id));
      row.append(button);

      if (unread) {
        const badge = document.createElement('span');
        badge.className = 'channel__badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.title = `읽지 않은 메시지 ${unread}개`;
        row.append(badge);
      }

      if (canManage && state.channels.length > 1) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'channel__remove';
        remove.title = '채널 삭제';
        remove.setAttribute('aria-label', `${channel.name} 채널 삭제`);
        remove.textContent = '×';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          deleteChannel(channel);
        });
        row.append(remove);
      }

      return row;
    }),
  );
}

/* ---------------------------------------------------------------- 메시지 */

function dateSeparator(timestamp) {
  const separator = document.createElement('div');
  separator.className = 'date-sep';
  separator.textContent = dateFormatter.format(new Date(timestamp));
  return separator;
}

function computeDividerTarget() {
  const unread = Math.max(0, Number(state.unread[state.channelId]) || 0);
  if (!unread) return null;
  const others = state.messages.filter((message) => message.userId !== state.me?.id);
  if (!others.length) return null;
  return others[Math.max(0, others.length - Math.min(unread, others.length))]?.id ?? null;
}

function newMessagesSeparator() {
  const separator = document.createElement('div');
  separator.className = 'new-sep';
  separator.setAttribute('role', 'separator');
  separator.textContent = '새 메시지';
  return separator;
}

function messageRow(message, grouped = false) {
  const mine = message.userId === state.me?.id;

  const row = document.createElement('div');
  row.className = `msg${mine ? ' msg--mine' : ''}${grouped ? ' msg--grouped' : ''}`;

  const body = document.createElement('div');
  body.className = 'msg__body';

  if (!mine && !grouped) {
    const author = document.createElement('span');
    author.className = 'msg__author';
    author.textContent = message.nickname;
    body.append(author);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble';
  bubble.textContent = message.text;

  const time = document.createElement('time');
  time.className = 'msg__time';
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = timeFormatter.format(new Date(message.createdAt));

  body.append(bubble, time);

  if (mine || state.canModerate) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'msg__delete';
    remove.title = '메시지 삭제';
    remove.setAttribute('aria-label', '메시지 삭제');
    remove.textContent = '삭제';
    remove.addEventListener('click', () => deleteMessage(message, mine));
    body.append(remove);
  }

  row.append(makeAvatar(message.nickname), body);
  return row;
}

function renderMessages(loading = false) {
  const fragment = document.createDocumentFragment();

  if (!state.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'messages__empty';
    const title = document.createElement('strong');
    title.textContent = loading ? '대화를 불러오는 중…' : '아직 메시지가 없어요';
    empty.append(title);
    if (!loading) {
      const description = document.createElement('span');
      description.textContent =
        state.channel === 'global'
          ? '첫 메시지를 남겨 모두에게 인사해 보세요.'
          : '이 방의 첫 메시지를 남겨 보세요.';
      empty.append(description);
    }
    fragment.append(empty);
  } else {
    const dividerId = state.channel === 'global' ? null : state.dividerMessageId;
    let dividerPlaced = !dividerId;
    let index = 0;
    let previous = null;
    for (const message of state.messages) {
      if (!dividerPlaced && index > 0 && message.id === dividerId) {
        fragment.append(newMessagesSeparator());
        dividerPlaced = true;
      }
      if (!previous || !isSameDay(previous.createdAt, message.createdAt)) {
        fragment.append(dateSeparator(message.createdAt));
        previous = null;
      }
      const grouped =
        previous !== null &&
        previous.userId === message.userId &&
        message.createdAt - previous.createdAt < 5 * 60 * 1000;
      fragment.append(messageRow(message, grouped));
      previous = message;
      index += 1;
    }
  }

  const previousTop = els.messages.scrollTop;
  els.messages.replaceChildren(fragment);

  const pending = state.pendingScroll;
  state.pendingScroll = null;
  const unread = pending === 'unread' ? els.messages.querySelector('.new-sep') : null;
  const saved = pending ? state.scrollPositions[scrollKey()] : undefined;
  if (unread) {
    const offset =
      unread.getBoundingClientRect().top -
      els.messages.getBoundingClientRect().top +
      els.messages.scrollTop;
    els.messages.scrollTop = Math.max(0, offset - 12);
  } else if (typeof saved === 'number' && saved > 0) {
    const maxScroll = Math.max(0, els.messages.scrollHeight - els.messages.clientHeight);
    els.messages.scrollTop = Math.min(saved, maxScroll);
  } else if (pending) {
    scrollToBottom('auto');
  } else {
    // 실시간 재연결·권한 변경 등으로 다시 그릴 때는 보던 위치를 유지한다.
    els.messages.scrollTop = previousTop;
  }
}

function appendMessage(message) {
  if (state.seen.has(message.id)) return;
  const nearBottom = isNearBottom();
  state.seen.add(message.id);

  els.messages.querySelector('.messages__empty')?.remove();

  const previous = state.messages[state.messages.length - 1] ?? null;
  const fragment = document.createDocumentFragment();

  if (!previous || !isSameDay(previous.createdAt, message.createdAt)) {
    fragment.append(dateSeparator(message.createdAt));
  }

  const grouped = Boolean(
    previous &&
      isSameDay(previous.createdAt, message.createdAt) &&
      previous.userId === message.userId &&
      message.createdAt - previous.createdAt < 5 * 60 * 1000,
  );

  fragment.append(messageRow(message, grouped));
  state.messages.push(message);
  els.messages.append(fragment);

  if (nearBottom || message.userId === state.me?.id) scrollToBottom('smooth');
}

function removeMessage(id) {
  if (!state.messages.some((message) => message.id === id)) return;
  state.seen.delete(id);
  state.messages = state.messages.filter((message) => message.id !== id);
  renderMessages();
}

async function deleteMessage(message, mine) {
  if (!mine) {
    const ok = await confirmAction({
      title: '메시지 삭제',
      text: `${message.nickname}님의 메시지를 삭제할까요?`,
      okText: '삭제',
    });
    if (!ok) return;
  }

  try {
    await api(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' });
    removeMessage(message.id);
    scheduleLobbyRefresh();
    toast('메시지를 삭제했어요.');
  } catch (error) {
    toast(error.message);
  }
}

function applySnapshot(messages) {
  state.messages = messages;
  state.seen = new Set(messages.map((message) => message.id));
  if (state.pendingScroll === 'unread') state.dividerMessageId = computeDividerTarget();
  renderMessages();
}

/* ---------------------------------------------------------------- 채널 */

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('code');
  if (state.channel === 'global') {
    url.searchParams.delete('room');
    url.searchParams.delete('ch');
  } else {
    url.searchParams.set('room', state.channel);
    if (state.channelId) url.searchParams.set('ch', state.channelId);
    else url.searchParams.delete('ch');
  }
  history.replaceState(null, '', url);
}

function inviteTarget() {
  const room = state.room?.room ?? null;
  if (room?.code) return `/?code=${room.code}`;
  return `/?room=${state.channel}`;
}

function messageQuery({ after, afterId } = {}) {
  const params = new URLSearchParams();
  if (state.channel === 'global') {
    params.set('channel', 'global');
  } else {
    params.set('room', state.channel);
    if (state.channelId) params.set('channelId', state.channelId);
  }
  if (after !== undefined) params.set('after', String(after));
  if (afterId !== undefined) params.set('afterId', afterId);
  return params.toString();
}

async function refreshSnapshot() {
  const channel = state.channel;
  const channelId = state.channelId;
  try {
    const data = await api(`/api/messages?${messageQuery()}`);
    if (state.channel !== channel || state.channelId !== channelId) return;
    applySnapshot(data.messages ?? []);
  } catch (error) {
    toast(error.message);
  }
}

let unreadWired = false;
let readTimer = null;

async function refreshUnread() {
  if (!state.me || state.channel === 'global') return;
  const room = state.channel;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(room)}/unread`);
    if (state.channel !== room) return;
    const next = {};
    const marks = { ...state.lastRead };
    for (const item of data.channels ?? []) {
      next[item.channelId] = Math.max(0, Number(item.unread) || 0);
      const mark = Number(item.lastReadAt);
      if (Number.isFinite(mark) && mark > 0) marks[item.channelId] = mark;
    }
    state.unread = next;
    state.lastRead = marks;
    renderChannels();
  } catch {
    // 배지는 보조 정보이므로 잠시 실패해도 화면을 막지 않는다.
  }
}

async function markChannelRead(channelId) {
  if (!state.me || !channelId) return;
  state.unread[channelId] = 0;
  try {
    await api(`/api/channels/${encodeURIComponent(channelId)}/read`, { method: 'POST' });
  } catch {
    // 다음 폴링에서 다시 시도한다.
  }
}

function scheduleMarkRead(channelId) {
  if (readTimer) return;
  readTimer = setTimeout(() => {
    readTimer = null;
    markChannelRead(channelId);
  }, 1200);
}

async function loadRoomDetail() {
  if (state.channel === 'global') {
    state.room = null;
    state.isOwner = false;
    state.isMember = false;
    state.isAdmin = false;
    state.canModerate = false;
    state.channels = [];
    state.channelId = null;
    return;
  }
  const detail = await api(`/api/rooms/${encodeURIComponent(state.channel)}`);
  state.room = detail;
  state.isOwner = detail.isOwner;
  state.isMember = detail.isMember;
  state.isAdmin = detail.isAdmin === true;
  state.canModerate = detail.canModerate === true;
  state.channels = detail.channels ?? [];
  if (!state.channels.some((channel) => channel.id === state.channelId)) {
    state.channelId = state.channels[0]?.id ?? null;
  }
  renderChannels();
}

function connectUnreadRealtime() {
  if (state.channel === 'global') {
    state.unreadRealtime?.close();
    state.unreadRealtime = null;
    state.unreadRoom = null;
    return;
  }
  if (state.unreadRoom === state.channel) return;

  state.unreadRealtime?.close();
  state.unreadRealtime = null;
  const room = state.channel;
  state.unreadRoom = room;

  try {
    state.unreadRealtime = connectRealtime({
      room: `room:${room}`,
      onStatus(status) {
        if (room !== state.channel) return;
        // 재연결되면 놓친 알림을 한 번 맞춰 준다.
        if (status === 'connected') refreshUnread();
      },
      onMessage(message) {
        if (room !== state.channel) return;
        if (message.type !== 'broadcast') return;

        if (message.event === 'message-deleted') {
          refreshUnread();
          return;
        }
        if (message.event === 'channel-deleted' && message.data?.channelId) {
          delete state.unread[message.data.channelId];
          renderChannels();
          return;
        }
        if (message.event !== 'channel-message') return;

        const channelId = message.data?.channelId;
        if (!channelId) return;
        if (message.data.userId === state.me?.id) return;
        if (channelId === state.channelId) return;
        state.unread[channelId] = (Math.max(0, Number(state.unread[channelId]) || 0) || 0) + 1;
        renderChannels();
      },
    });
  } catch {
    state.unreadRoom = null;
  }
}

function connectChannelRealtime() {
  state.realtime?.close();
  state.realtime = null;
  state.realtimeReady = false;
  state.roomUsers = [];
  renderChatHeader();

  const channel = state.channel;
  const channelId = state.channelId;
  try {
    state.realtime = connectRealtime({
      room: channel === 'global' ? 'global' : `ch:${state.channelId}`,
      channelId: state.channelId,
      onStatus(status) {
        if (channel !== state.channel || channelId !== state.channelId) return;
        const wasReady = state.realtimeReady;
        state.realtimeReady = status === 'connected';
        if (state.realtimeReady) {
          state.realtime?.presence({ nickname: state.me?.nickname ?? '' });
          if (!wasReady) refreshSnapshot();
        } else if (wasReady) {
          state.roomUsers = [];
        }
        renderChatHeader();
      },
      onMessage(message) {
        if (channel !== state.channel || channelId !== state.channelId) return;
        if (message.type === 'broadcast' && message.event === 'message' && message.data) {
          appendMessage(message.data);
          scheduleLobbyRefresh();
          scheduleMarkRead(state.channelId);
          return;
        }
        if (message.type === 'broadcast' && message.event === 'message-deleted' && message.data?.id) {
          removeMessage(message.data.id);
          return;
        }
        if (message.type === 'broadcast' && message.event === 'roles-changed') {
          loadRoomDetail()
            .then(() => {
              renderMessages();
              renderChatHeader();
              if (els.settingsDialog.open) renderMembers(state.room?.members ?? []);
            })
            .catch(() => {});
          return;
        }
        if (message.type === 'broadcast' && message.event === 'owner-changed') {
          loadRoomDetail()
            .then(() => {
              renderChatHeader();
              if (els.settingsDialog.open && !state.isOwner) {
                els.settingsDialog.close();
                toast('방장이 바뀌었어요.');
              } else if (els.settingsDialog.open) {
                renderMembers(state.room?.members ?? []);
              }
              renderMessages();
              loadLobby().catch(() => {});
            })
            .catch(() => {});
          return;
        }
        if (message.type === 'broadcast' && message.event === 'channel-deleted') {
          toast('채널이 삭제되었어요.');
          loadRoomDetail()
            .then(() => {
              renderChatHeader();
              if (!state.channels.some((item) => item.id === state.channelId)) {
                openChannel(state.channel, state.channels[0]?.id ?? null).catch(() => {});
              }
            })
            .catch(() => {});
          return;
        }
        if (message.type === 'broadcast' && message.event === 'room-deleted') {
          toast('방장이 방을 삭제했어요.');
          loadLobby().catch(() => {});
          openChannel('global').catch(() => {});
          return;
        }
        if (message.type === 'presence') {
          const users = new Map();
          for (const member of message.members ?? []) {
            if (!users.has(member.userId)) {
              users.set(member.userId, {
                id: member.userId,
                nickname: member.data?.nickname || member.userId,
              });
            }
          }
          state.roomUsers = [...users.values()];
          renderChatHeader();
        }
      },
    });
  } catch {
    // realtime을 쓸 수 없는 환경에서는 폴링만으로 동작한다.
  }

  connectUnreadRealtime();
}

async function openChannel(channel, channelId = null) {
  const nextChannelId = channel === 'global' ? null : channelId;
  const changed =
    channel !== state.channel || (nextChannelId ?? null) !== (state.channelId ?? null);

  if (changed) closeVoice();
  // 모바일에서 방 링크로 바로 들어와도 채팅 화면이 보이도록 한다.
  document.body.classList.add('chat-open');

  if (!changed) {
    document.body.classList.add('chat-open');
    els.messageInput.focus();
    return;
  }

  // 떠나기 전 채널의 스크롤 위치를 기억해 둔다.
  saveScrollPosition();

  const sameRoom = channel === state.channel;
  state.channel = channel;
  state.channelId = nextChannelId;
  if (els.settingsDialog.open) els.settingsDialog.close();
  state.messages = [];
  state.seen = new Set();
  state.roomUsers = [];
  document.body.classList.add('chat-open');
  renderRooms();
  renderChatHeader();
  renderChannels();
  renderMessages(true);

  if (!sameRoom || channel === 'global') {
    state.room = null;
    state.isOwner = false;
    state.isMember = false;
    state.isAdmin = false;
    state.canModerate = false;
    state.channels = [];
    state.unread = {};
    state.lastRead = {};
    state.dividerMessageId = null;
  }

  try {
    await loadRoomDetail();
    if (channel !== 'global' && !state.isMember && !state.isOwner) {
      await api(`/api/rooms/${encodeURIComponent(channel)}/join`, { method: 'POST' });
      await loadRoomDetail();
    }
  } catch (error) {
    toast(error.message);
  }

  await loadServerPositions();
  updateUrl();
  renderChannels();
  // 상세(권한) 정보를 받은 뒤 권한에 맞는 삭제 버튼을 다시 그린다.
  renderMessages();
  connectChannelRealtime();
  await refreshUnread();
  state.pendingScroll = 'unread';
  await refreshSnapshot();
  await markChannelRead(state.channelId);
  renderChannels();
  renderChatHeader();
  els.messageInput.focus();
}

/* ---------------------------------------------------------------- 서버 동기화 */

async function loadLobby() {
  const data = await api('/api/rooms');
  state.rooms = data.rooms ?? [];
  state.global = data.global ?? { lastMessage: null };
  renderRooms();
  renderChatHeader();
}

let lobbyTimer = null;
function scheduleLobbyRefresh() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    loadLobby().catch(() => {});
  }, 250);
}

async function pollChannel() {
  if (state.realtimeReady) return;
  const channel = state.channel;
  const channelId = state.channelId;
  const last = state.messages[state.messages.length - 1];
  const query = messageQuery(
    last ? { after: last.createdAt, afterId: last.id } : undefined,
  );

  try {
    const data = await api(`/api/messages?${query}`);
    if (state.channel !== channel || state.channelId !== channelId) return;
    for (const message of data.messages ?? []) appendMessage(message);
  } catch {
    // 일시적인 네트워크 오류는 다음 폴링에서 회복한다.
  }
}

async function sendMessage(text) {
  const channel = state.channel;
  const channelId = state.channelId;
  els.messageInput.value = '';
  els.messageInput.focus();

  try {
    const data = await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        roomId: channel === 'global' ? null : channel,
        channelId: channel === 'global' ? null : channelId,
        text,
      }),
    });
    if (state.channel === channel && state.channelId === channelId) {
      if (channelId) state.lastRead[channelId] = data.message.createdAt;
      appendMessage(data.message);
    }
    scheduleLobbyRefresh();
  } catch (error) {
    toast(error.message);
  }
}

/* ---------------------------------------------------------------- 친구 */

function updateFriendBadge() {
  const count = state.friends.incoming?.length ?? 0;
  els.friendBadge.hidden = count === 0;
  els.friendBadge.textContent = String(count);
}

async function refreshFriends() {
  const data = await api('/api/friends');
  state.friends = {
    friends: data.friends ?? [],
    incoming: data.incoming ?? [],
    outgoing: data.outgoing ?? [],
  };
  updateFriendBadge();
  renderFriends();
}

function renderFriends() {
  const { friends, incoming, outgoing } = state.friends;

  els.incomingCount.textContent = incoming.length ? String(incoming.length) : '';
  els.outgoingCount.textContent = outgoing.length ? String(outgoing.length) : '';
  els.friendCount.textContent = friends.length ? String(friends.length) : '';

  if (!incoming.length) {
    els.incomingList.replaceChildren(emptyNote('받은 요청이 없어요.'));
  } else {
    els.incomingList.replaceChildren(
      ...incoming.map((item) => {
        const row = personRow({ id: item.userId, nickname: item.nickname });
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';

        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'btn btn--primary';
        accept.style.padding = '5px 10px';
        accept.style.fontSize = '12.5px';
        accept.textContent = '수락';
        accept.addEventListener('click', () => respondFriend(item.id, 'accept'));

        const decline = document.createElement('button');
        decline.type = 'button';
        decline.className = 'btn btn--ghost';
        decline.style.padding = '5px 10px';
        decline.style.fontSize = '12.5px';
        decline.textContent = '거절';
        decline.addEventListener('click', () => respondFriend(item.id, 'decline'));

        actions.append(accept, decline);
        row.append(actions);
        return row;
      }),
    );
  }

  if (!outgoing.length) {
    els.outgoingList.replaceChildren(emptyNote('보낸 요청이 없어요.'));
  } else {
    els.outgoingList.replaceChildren(
      ...outgoing.map((item) =>
        personRow({ id: item.userId, nickname: item.nickname, action: { label: '대기 중', className: 'btn btn--ghost' , onClick: () => {} } }),
      ),
    );
  }

  if (!friends.length) {
    els.friendList.replaceChildren(emptyNote('아직 친구가 없어요. 아이디로 요청해 보세요.'));
  } else {
    els.friendList.replaceChildren(
      ...friends.map((friend) =>
        personRow({
          id: friend.id,
          nickname: friend.nickname,
          action: {
            label: '삭제',
            className: 'btn btn--danger',
            onClick: () => removeFriend(friend.id),
          },
        }),
      ),
    );
  }
}

async function openFriends() {
  els.friendsError.textContent = '';
  try {
    await refreshFriends();
    els.friendsDialog.showModal();
    els.friendId.focus();
  } catch (error) {
    toast(error.message);
  }
}

async function respondFriend(requestId, action) {
  try {
    await api(`/api/friends/requests/${encodeURIComponent(requestId)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    await refreshFriends();
    toast(action === 'accept' ? '친구가 되었어요.' : '요청을 거절했어요.');
  } catch (error) {
    els.friendsError.textContent = error.message;
  }
}

async function removeFriend(friendId) {
  try {
    await api(`/api/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
    await refreshFriends();
    toast('친구를 삭제했어요.');
  } catch (error) {
    els.friendsError.textContent = error.message;
  }
}

/* ---------------------------------------------------------------- 방 설정 */

function selectedVisibility(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? 'public';
}

async function loadModerationLog() {
  els.moderationCount.textContent = '';
  els.moderationList.replaceChildren(emptyNote('삭제 기록을 불러오는 중…'));

  try {
    const data = await api(`/api/rooms/${encodeURIComponent(state.channel)}/moderation`);
    renderModeration(data.entries ?? []);
  } catch (error) {
    els.moderationList.replaceChildren(emptyNote(error.message));
  }
}

function renderModeration(entries) {
  els.moderationCount.textContent = entries.length ? String(entries.length) : '';

  if (!entries.length) {
    els.moderationList.replaceChildren(emptyNote('아직 삭제 기록이 없어요.'));
    return;
  }

  els.moderationList.replaceChildren(
    ...entries.map((entry) => {
      const row = document.createElement('div');
      row.className = 'log';

      const line = document.createElement('p');
      line.className = 'log__line';
      line.textContent = `${entry.actorNickname}님이 ${entry.authorNickname}님의 메시지를 삭제`;

      const text = document.createElement('p');
      text.className = 'log__text';
      text.textContent = entry.messageText;

      const time = document.createElement('time');
      time.className = 'log__time';
      const at = new Date(entry.createdAt);
      time.dateTime = at.toISOString();
      time.textContent = `${dateFormatter.format(at)} ${timeFormatter.format(at)}`;

      row.append(line, text, time);
      return row;
    }),
  );
}

function renderMembers(members) {
  state.settingsMembers = members;
  els.memberCount.textContent = String(members.length);

  if (!members.length) {
    els.memberList.replaceChildren(emptyNote('아직 참여자가 없어요.'));
    return;
  }

  els.memberList.replaceChildren(
    ...members.map((member) => {
      const isSelfOwner = member.id === state.room?.room?.ownerId;
      const isAdmin = member.role === 'admin';
      return personRow({
        id: member.id,
        nickname: member.nickname,
        badge: isAdmin ? '관리자' : null,
        action: isSelfOwner ? { label: '방장', className: 'btn btn--ghost', onClick: () => {} } : null,
        actions: isSelfOwner || !state.isOwner
          ? null
          : [
              {
                label: isAdmin ? '관리자 해제' : '관리자 지정',
                className: 'btn btn--ghost',
                onClick: () => setMemberRole(member, isAdmin ? 'member' : 'admin'),
              },
              {
                label: '방장 넘기기',
                className: 'btn btn--ghost',
                onClick: () => transferOwner(member),
              },
              {
                label: '내보내기',
                className: 'btn btn--danger',
                onClick: () => removeMember(member.id),
              },
            ],
      });
    }),
  );
}

function renderInviteFriends(members, friends) {
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = friends.filter((friend) => !memberIds.has(friend.id));
  els.inviteFriendCount.textContent = candidates.length ? String(candidates.length) : '';

  if (!candidates.length) {
    els.inviteFriendList.replaceChildren(
      emptyNote('초대할 수 있는 친구가 없어요. 친구를 먼저 추가해 보세요.'),
    );
    return;
  }

  els.inviteFriendList.replaceChildren(
    ...candidates.map((friend) =>
      personRow({
        id: friend.id,
        nickname: friend.nickname,
        action: {
          label: '초대',
          className: 'btn btn--ghost',
          onClick: () => inviteFriend(friend.id),
        },
      }),
    ),
  );
}

function fillSettings(detail, friends) {
  const room = detail.room;
  els.settingsName.value = room.name;
  els.settingsDesc.value = room.description ?? '';
  for (const input of document.querySelectorAll('input[name="settings-visibility"]')) {
    input.checked = input.value === room.visibility;
  }
  els.roomCode.textContent = room.code ?? '------';
  state.settingsFriends = friends.friends ?? [];
  renderMembers(detail.members ?? []);
  renderInviteFriends(detail.members ?? [], state.settingsFriends);
}

async function openSettings() {
  if (state.channel === 'global') return;
  els.settingsError.textContent = '';
  try {
    const [detail, friends] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(state.channel)}`),
      api('/api/friends'),
    ]);
    if (!detail.isOwner) {
      toast('방장만 설정을 바꿀 수 있어요.');
      return;
    }
    state.room = detail;
    state.isOwner = true;
    state.isMember = true;
    fillSettings(detail, friends);
    await loadModerationLog();
    els.settingsDialog.showModal();
  } catch (error) {
    toast(error.message);
  }
}

async function inviteFriend(userId) {
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(state.channel)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    renderMembers(data.members ?? []);
    renderInviteFriends(data.members ?? [], state.settingsFriends);
    toast('친구를 초대했어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

async function deleteChannel(channel) {
  const wasCurrent = state.channelId === channel.id;
  const ok = await confirmAction({
    title: '채널 삭제',
    text: `'# ${channel.name}' 채널과 대화가 모두 삭제돼요.`,
    okText: '삭제',
  });
  if (!ok) return;

  try {
    await api(`/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE' });
    await loadRoomDetail();
    renderChannels();
    if (wasCurrent) {
      await openChannel(state.channel, state.channelId);
    } else {
      renderChatHeader();
    }
    toast('채널을 삭제했어요.');
  } catch (error) {
    toast(error.message);
  }
}

async function setMemberRole(member, role) {
  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(state.channel)}/members/${encodeURIComponent(member.id)}/role`,
      { method: 'POST', body: JSON.stringify({ role }) },
    );
    renderMembers(data.members ?? []);
    renderInviteFriends(data.members ?? [], state.settingsFriends);
    toast(role === 'admin' ? '관리자로 지정했어요.' : '관리자를 해제했어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

async function transferOwner(member) {
  const ok = await confirmAction({
    title: '방장 넘기기',
    text: `'${member.nickname}'님에게 방장을 넘길까요? 넘기면 설정과 삭제 권한이 사라져요.`,
    okText: '넘기기',
  });
  if (!ok) return;

  try {
    const data = await api(`/api/rooms/${encodeURIComponent(state.channel)}/owner`, {
      method: 'POST',
      body: JSON.stringify({ userId: member.id }),
    });
    state.room = data;
    state.isOwner = data.isOwner;
    state.isMember = data.isMember;
    if (els.settingsDialog.open) els.settingsDialog.close();
    await loadLobby();
    renderChatHeader();
    toast('방장을 넘겼어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

async function removeMember(userId) {
  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(state.channel)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
    renderMembers(data.members ?? []);
    renderInviteFriends(data.members ?? [], state.settingsFriends);
    toast('내보냈어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

/* ---------------------------------------------------------------- 나가기·삭제 */

let confirmResolve = null;

function confirmAction({ title, text, okText = '확인' }) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okText;
  els.confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  resolve?.(value);
}

async function leaveRoom() {
  if (state.channel === 'global') return;
  const ok = await confirmAction({
    title: '방 나가기',
    text: '방에서 나가면 다시 들어오려면 코드나 초대가 필요해요.',
    okText: '나가기',
  });
  if (!ok) return;

  try {
    await api(`/api/rooms/${encodeURIComponent(state.channel)}/leave`, { method: 'POST' });
    await loadLobby();
    await openChannel('global');
    toast('방에서 나왔어요.');
  } catch (error) {
    toast(error.message);
  }
}

async function deleteRoom() {
  if (state.channel === 'global') return;
  const ok = await confirmAction({
    title: '방 삭제',
    text: '방과 대화 내용이 모두 사라지고 되돌릴 수 없어요.',
    okText: '삭제',
  });
  if (!ok) return;

  try {
    await api(`/api/rooms/${encodeURIComponent(state.channel)}`, { method: 'DELETE' });
    els.settingsDialog.close();
    await loadLobby();
    await openChannel('global');
    toast('방을 삭제했어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
}

/* ---------------------------------------------------------------- 입장 처리 */

async function enterApp() {
  els.meNickname.textContent = state.me.nickname;
  els.meId.textContent = `@${state.me.id}`;
  els.meAvatar.textContent = String(state.me.nickname).slice(0, 1).toUpperCase();
  els.meAvatar.style.setProperty('--avatar-hue', String(hueFor(state.me.nickname)));

  els.loginView.hidden = true;
  els.appView.hidden = false;

  applyChatZoom();
  await loadLobby();

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const requested = params.get('room');
  const requestedChannel = params.get('ch');

  if (code) {
    try {
      const data = await api('/api/rooms/join', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      await loadLobby();
      state.channel = data.room.id;
    } catch (error) {
      toast(error.message);
    }
  } else if (requested) {
    state.channel = requested;
    state.channelId = requestedChannel;
  }

  updateUrl();
  // 방 링크로 들어온 경우 모바일에서도 채팅 화면을 바로 보여준다.
  if (state.channel !== 'global') document.body.classList.add('chat-open');

  try {
    await loadRoomDetail();
  } catch (error) {
    toast(error.message);
    state.channel = 'global';
  }

  await loadServerPositions();

  renderRooms();
  renderChatHeader();
  renderMessages(true);
  connectChannelRealtime();
  await refreshUnread();
  state.pendingScroll = 'unread';
  await refreshSnapshot();
  els.messageInput.focus();

  setInterval(pollChannel, 2500);
  setInterval(() => loadLobby().catch(() => {}), 8000);
  setInterval(() => refreshFriends().catch(() => {}), 15000);
  if (!unreadWired) {
    unreadWired = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshUnread();
    });
    window.addEventListener('focus', () => refreshUnread());
  }
  refreshFriends().catch(() => {});
}

async function boot() {
  initTheme();
  try {
    const { user } = await api('/api/me');
    state.me = user;
    loadScrollPositions();
    await enterApp();
  } catch {
    els.loginView.hidden = false;
    els.appView.hidden = true;
    els.loginId.focus();
  }
}

/* ---------------------------------------------------------------- 이벤트 */

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.textContent = '';

  const userId = els.loginId.value.trim();
  const nickname = els.loginNickname.value.trim();

  if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(userId)) {
    els.loginError.textContent = '아이디는 영문·숫자·_ . - 로 3~20자로 정해 주세요.';
    return;
  }
  if (nickname.length < 1) {
    els.loginError.textContent = '닉네임을 입력해 주세요.';
    return;
  }

  els.loginSubmit.disabled = true;
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ userId, nickname }),
    });
    state.me = user;
    await enterApp();
  } catch (error) {
    els.loginError.textContent = error.message;
  } finally {
    els.loginSubmit.disabled = false;
  }
});

els.zoomOut.addEventListener('click', () => setChatZoom(state.chatZoom - 0.1));
els.zoomIn.addEventListener('click', () => setChatZoom(state.chatZoom + 0.1));

els.voiceBtn.addEventListener('click', () => {
  if (state.voice?.joined) {
    closeVoice();
    return;
  }
  openVoice().catch(() => toast('음성 연결에 실패했어요.'));
});

els.voiceClose.addEventListener('click', () => closeVoice());
els.voiceLeave.addEventListener('click', () => closeVoice());
els.voiceMic.addEventListener('click', async () => {
  if (!state.voice) return;
  await state.voice.toggleMic().catch(() => {});
  renderVoice();
});
els.voiceScreen.addEventListener('click', async () => {
  if (!state.voice) return;
  const snap = state.voice.snapshot();
  if (snap.screenOn) await state.voice.stopScreen().catch(() => {});
  else await state.voice.startScreen().catch(() => {});
  renderVoice();
});
els.voiceZoomIn.addEventListener('click', () => {
  state.voiceZoom = Math.min(3, Math.round((state.voiceZoom + 0.25) * 100) / 100);
  applyVoiceZoom();
});
els.voiceZoomOut.addEventListener('click', () => {
  state.voiceZoom = Math.max(1, Math.round((state.voiceZoom - 0.25) * 100) / 100);
  applyVoiceZoom();
});

els.roomSearch.addEventListener('input', () => {
  state.filter = els.roomSearch.value;
  renderRooms();
});

els.createRoomBtn.addEventListener('click', () => {
  els.createRoomForm.reset();
  els.createRoomError.textContent = '';
  els.createRoomDialog.showModal();
  els.roomName.focus();
});

els.cancelRoomBtn.addEventListener('click', () => els.createRoomDialog.close());

els.createChannelBtn.addEventListener('click', () => {
  els.channelForm.reset();
  els.channelError.textContent = '';
  els.channelDialog.showModal();
  els.channelName.focus();
});

els.cancelChannelBtn.addEventListener('click', () => els.channelDialog.close());

els.channelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.channelError.textContent = '';

  const name = els.channelName.value.trim();
  if (!name) {
    els.channelError.textContent = '채널 이름을 입력해 주세요.';
    return;
  }

  try {
    const data = await api(`/api/rooms/${encodeURIComponent(state.channel)}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    els.channelDialog.close();
    await loadRoomDetail();
    renderChannels();
    await openChannel(state.channel, data.channel?.id ?? state.channelId);
    toast('채널을 만들었어요.');
  } catch (error) {
    els.channelError.textContent = error.message;
  }
});

els.createRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.createRoomError.textContent = '';

  const name = els.roomName.value.trim();
  if (name.length < 2) {
    els.createRoomError.textContent = '방 이름은 2자 이상으로 정해 주세요.';
    return;
  }

  try {
    const { room } = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: els.roomDesc.value.trim(),
        visibility: selectedVisibility('visibility'),
      }),
    });
    els.createRoomDialog.close();
    await loadLobby();
    await openChannel(room.id);
    if (room.visibility === 'public') {
      toast('방을 만들었어요. 링크를 복사해 친구를 초대해 보세요.');
    } else {
      toast('방을 만들었어요. 방 설정에서 코드를 확인하세요.');
    }
  } catch (error) {
    els.createRoomError.textContent = error.message;
  }
});

els.joinCodeBtn.addEventListener('click', () => {
  els.joinForm.reset();
  els.joinError.textContent = '';
  els.joinDialog.showModal();
  els.joinCode.focus();
});

els.closeJoinBtn.addEventListener('click', () => els.joinDialog.close());

els.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.joinError.textContent = '';

  const code = els.joinCode.value.trim().toUpperCase();
  if (code.length < 4) {
    els.joinError.textContent = '방 코드를 입력해 주세요.';
    return;
  }

  try {
    const data = await api('/api/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    els.joinDialog.close();
    await loadLobby();
    await openChannel(data.room.id);
    toast(`'${data.room.name}' 방에 입장했어요.`);
  } catch (error) {
    els.joinError.textContent = error.message;
  }
});

els.settingsBtn.addEventListener('click', openSettings);
els.leaveBtn.addEventListener('click', leaveRoom);
els.deleteRoomBtn.addEventListener('click', deleteRoom);
els.closeSettingsBtn.addEventListener('click', () => els.settingsDialog.close());
els.confirmCancel.addEventListener('click', () => settleConfirm(false));
els.confirmOk.addEventListener('click', () => settleConfirm(true));
els.confirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  settleConfirm(false);
});

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.settingsError.textContent = '';

  const name = els.settingsName.value.trim();
  if (name.length < 2) {
    els.settingsError.textContent = '방 이름은 2자 이상으로 정해 주세요.';
    return;
  }

  try {
    const detail = await api(`/api/rooms/${encodeURIComponent(state.channel)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name,
        description: els.settingsDesc.value.trim(),
        visibility: selectedVisibility('settings-visibility'),
      }),
    });
    state.room = detail;
    state.isOwner = detail.isOwner;
    els.roomCode.textContent = detail.room.code ?? '------';
    await loadLobby();
    renderChatHeader();
    toast('방 설정을 저장했어요.');
  } catch (error) {
    els.settingsError.textContent = error.message;
  }
});

els.copyCodeBtn.addEventListener('click', () => {
  const code = els.roomCode.textContent?.trim();
  if (code && code !== '------') copyText(code);
});

els.friendsBtn.addEventListener('click', openFriends);
els.closeFriendsBtn.addEventListener('click', () => els.friendsDialog.close());

els.addFriendForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.friendsError.textContent = '';

  const userId = els.friendId.value.trim();
  if (!userId) {
    els.friendsError.textContent = '친구 아이디를 입력해 주세요.';
    return;
  }

  try {
    const result = await api('/api/friends/requests', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    els.friendId.value = '';
    await refreshFriends();
    toast(result.status === 'accepted' ? '친구가 되었어요.' : '친구 요청을 보냈어요.');
  } catch (error) {
    els.friendsError.textContent = error.message;
  }
});

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (text) sendMessage(text);
});

els.inviteBtn.addEventListener('click', () => copyText(inviteTarget()));

els.backBtn.addEventListener('click', () => {
  document.body.classList.remove('chat-open');
});

els.logoutBtn.addEventListener('click', async () => {
  state.realtime?.close();
  closeVoice();
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // 쿠키 삭제가 실패해도 화면은 초기화한다.
  }
  location.replace('/');
});

boot();
