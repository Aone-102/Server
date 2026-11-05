/**
 * 링크챗 스모크 테스트.
 *
 * 로컬:
 *   npm run realtime   (터미널 1 — 실시간 헬퍼)
 *   npm run dev        (터미널 2 — 앱)
 *   npm run smoke
 *
 * 배포 환경:
 *   BASE_URL=https://... APP_ORIGIN=https://... npm run smoke
 */
import WebSocket from 'ws';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const ORIGIN = process.env.APP_ORIGIN ?? new URL(BASE).origin;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`✅ ${name}`);
  } else {
    failures += 1;
    console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function login(userId, nickname) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ userId, nickname }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`로그인 실패 (${response.status}): ${data.error ?? ''}`);

  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = setCookies.map((value) => value.split(';')[0]).find(Boolean);
  if (!cookie) throw new Error('세션 쿠키를 받지 못했습니다.');
  return { user: data.user, cookie };
}

function authFetch(path, cookie, options = {}) {
  return fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      cookie,
      ...(options.headers ?? {}),
    },
  });
}

async function jsonOrEmpty(response) {
  return response.json().catch(() => ({}));
}

async function createRoom(cookie, body) {
  const response = await authFetch('/api/rooms', cookie, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await jsonOrEmpty(response) };
}

function openSocket(url, origin) {
  const socket = new WebSocket(url, { origin });
  const inbox = [];
  socket.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)));
    } catch {
      // 무시
    }
  });

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, inbox }));
    socket.once('error', reject);
  });
}

async function waitForInbox(inbox, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = inbox.find((value) => predicate(value));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('실시간 메시지 대기 시간 초과');
}

const stamp = Date.now().toString(36);
const alice = await login(`alice_${stamp}`, '앨리스');
const bob = await login(`bob_${stamp}`, '밥');
const carol = await login(`carol_${stamp}`, '캐럴');

check(
  '로그인 후 내 정보 조회',
  (await (await authFetch('/api/me', alice.cookie)).json()).user?.id === alice.user.id,
);
check('비로그인 방 목록 요청은 401', (await fetch(`${BASE}/api/rooms`)).status === 401);

/* ---------------------------------------------------------------- 공개방 */

const publicRoom = await createRoom(alice.cookie, {
  name: `공개방 ${stamp}`,
  description: '누구나 입장',
  visibility: 'public',
});
check('공개방 생성', publicRoom.status === 201 && publicRoom.data.room?.visibility === 'public');
check('방 코드 자동 발급', /^[A-Z0-9]{6}$/.test(publicRoom.data.room?.code ?? ''), String(publicRoom.data.room?.code));

const bobLobby = await (await authFetch('/api/rooms', bob.cookie)).json();
check('공개방은 다른 사용자 로비에 보임', bobLobby.rooms?.some((room) => room.id === publicRoom.data.room.id));

/* ---------------------------------------------------------------- 친구 초대방 */

const inviteRoom = await createRoom(alice.cookie, {
  name: `초대방 ${stamp}`,
  visibility: 'invite',
});
check('친구 초대방 생성', inviteRoom.status === 201 && inviteRoom.data.room?.visibility === 'invite');

const bobLobbyAfterInvite = await (await authFetch('/api/rooms', bob.cookie)).json();
check(
  '초대방은 다른 사용자 로비에 숨겨짐',
  !bobLobbyAfterInvite.rooms?.some((room) => room.id === inviteRoom.data.room.id),
);

const wrongCode = await authFetch('/api/rooms/join', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ code: 'ZZZZZZ' }),
});
check('잘못된 코드는 404', wrongCode.status === 404);

const codeJoin = await authFetch('/api/rooms/join', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ code: inviteRoom.data.room.code }),
});
check('코드로 초대방 입장', codeJoin.status === 200);

const inviteMessage = await authFetch('/api/messages', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: inviteRoom.data.room.id, text: '코드로 들어왔어요.' }),
});
check('초대방 메시지 전송', inviteMessage.status === 201);

/* ---------------------------------------------------------------- 비공개방 */

const privateRoom = await createRoom(alice.cookie, {
  name: `비공개방 ${stamp}`,
  visibility: 'private',
});
check('비공개방 생성', privateRoom.status === 201 && privateRoom.data.room?.visibility === 'private');

const blockedJoin = await authFetch(`/api/rooms/${privateRoom.data.room.id}/join`, bob.cookie, {
  method: 'POST',
  body: JSON.stringify({}),
});
check('비공개방은 코드 없이 입장 불가', blockedJoin.status === 403);

const blockedCodeJoin = await authFetch('/api/rooms/join', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ code: privateRoom.data.room.code }),
});
check('비공개방은 코드만으로 입장 불가', blockedCodeJoin.status === 403);

const blockedRead = await authFetch(
  `/api/messages?channel=${privateRoom.data.room.id}`,
  bob.cookie,
);
check('비공개방 메시지 접근 차단', blockedRead.status === 403);

const blockedTicket = await authFetch('/api/realtime/ticket', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ room: `room:${privateRoom.data.room.id}` }),
});
check('비공개방 실시간 티켓 차단', blockedTicket.status === 403);

/* ---------------------------------------------------------------- 방 설정 */

const forbiddenPatch = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie, {
  method: 'PATCH',
  body: JSON.stringify({ name: '가로채기', description: '', visibility: 'public' }),
});
check('방장이 아니면 설정 변경 403', forbiddenPatch.status === 403);

const ownerDetail = await (
  await authFetch(`/api/rooms/${privateRoom.data.room.id}`, alice.cookie)
).json();
check(
  '방장에게만 방 코드 노출',
  ownerDetail.isOwner === true && ownerDetail.room?.code === privateRoom.data.room.code,
);

const patch = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, alice.cookie, {
  method: 'PATCH',
  body: JSON.stringify({ name: `비공개방 ${stamp}`, description: '설정 변경됨', visibility: 'private' }),
});
const patched = await jsonOrEmpty(patch);
check(
  '방장 설정 변경',
  patch.status === 200 && patched.room?.description === '설정 변경됨',
);

const aliceDetail = await (await authFetch(`/api/rooms/${privateRoom.data.room.id}`, alice.cookie)).json();
const bobDetailBeforeInvite = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie);
check('비공개방 상세는 비멤버에게 403', bobDetailBeforeInvite.status === 403);
check('방장 상세에 코드 포함', aliceDetail.room?.code === privateRoom.data.room.code);

/* ---------------------------------------------------------------- 친구 */

const sendRequest = await authFetch('/api/friends/requests', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: bob.user.id }),
});
check('친구 요청 보내기', sendRequest.status === 201);

const bobFriends = await (await authFetch('/api/friends', bob.cookie)).json();
check(
  '받은 친구 요청 확인',
  bobFriends.incoming?.some((item) => item.userId === alice.user.id),
);

const accept = await authFetch(
  `/api/friends/requests/${bobFriends.incoming[0].id}/respond`,
  bob.cookie,
  { method: 'POST', body: JSON.stringify({ action: 'accept' }) },
);
check('친구 요청 수락', accept.status === 200);

const aliceFriends = await (await authFetch('/api/friends', alice.cookie)).json();
const bobFriendsAfter = await (await authFetch('/api/friends', bob.cookie)).json();
check(
  '양쪽 친구 목록에 반영',
  aliceFriends.friends?.some((friend) => friend.id === bob.user.id) &&
    bobFriendsAfter.friends?.some((friend) => friend.id === alice.user.id),
);

const strangerInvite = await authFetch(`/api/rooms/${privateRoom.data.room.id}/members`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: carol.user.id }),
});
check('친구가 아니면 방 초대 불가', strangerInvite.status === 403);

const inviteFriend = await authFetch(`/api/rooms/${privateRoom.data.room.id}/members`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: bob.user.id }),
});
const invitedMembers = await jsonOrEmpty(inviteFriend);
check(
  '친구를 비공개방에 초대',
  inviteFriend.status === 200 && invitedMembers.members?.some((member) => member.id === bob.user.id),
);

const bobDetailAfterInvite = await (
  await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie)
).json();
check('초대 후 비공개방 접근 가능', bobDetailAfterInvite.isMember === true);
check('초대받은 멤버에게는 코드 미노출', bobDetailAfterInvite.room?.code === undefined);

const memberMessage = await authFetch('/api/messages', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: privateRoom.data.room.id, text: '초대받고 들어왔어요.' }),
});
check('초대 후 비공개방 메시지 전송', memberMessage.status === 201);

/* ---------------------------------------------------------------- 실시간 */

async function ticketFor(cookie, room) {
  const response = await authFetch('/api/realtime/ticket', cookie, {
    method: 'POST',
    body: JSON.stringify({ room: room ?? 'global' }),
  });
  return { status: response.status, data: await jsonOrEmpty(response) };
}

const privateChannelScope = `ch:${privateRoom.data.channels?.[0]?.id}`;
const memberTicket = await ticketFor(bob.cookie, privateChannelScope);
check('멤버는 비공개방 티켓 발급 가능', memberTicket.status === 200);

if (memberTicket.status !== 200) {
  check('실시간 소켓/브로드캐스트', false, '티켓 발급 실패');
} else {
  const aliceTicket = await ticketFor(alice.cookie, privateChannelScope);
  const { socket: socketA, inbox: inboxA } = await openSocket(
    aliceTicket.data.websocketUrl,
    ORIGIN,
  );
  const { socket: socketB, inbox: inboxB } = await openSocket(
    memberTicket.data.websocketUrl,
    ORIGIN,
  );
  check(
    '실시간 소켓 연결',
    Boolean(await waitForInbox(inboxB, (value) => value.type === 'ready')),
  );

  const presence = await waitForInbox(
    inboxB,
    (value) => value.type === 'presence' && value.members?.length >= 2,
  );
  check('프레즌스 동기화', presence.members.length >= 2);

  const realtimeMessage = await authFetch('/api/messages', alice.cookie, {
    method: 'POST',
    body: JSON.stringify({
      roomId: privateRoom.data.room.id,
      channelId: privateRoom.data.channels?.[0]?.id,
      text: '실시간 브로드캐스트',
    }),
  });
  check('실시간 메시지 저장', realtimeMessage.status === 201);

  const broadcast = await waitForInbox(
    inboxB,
    (value) => value.type === 'broadcast' && value.event === 'message',
  );
  check('실시간 브로드캐스트 수신', broadcast.data?.text === '실시간 브로드캐스트');

  socketA.close();
  socketB.close();
}

/* ---------------------------------------------------------------- 서버 채널 */

const serverRoom = await createRoom(alice.cookie, {
  name: `서버방 ${stamp}`,
  visibility: 'public',
});
const serverId = serverRoom.data.room.id;
const defaultChannelId = serverRoom.data.channels?.[0]?.id;
check(
  '서버 생성 시 기본 채널 자동 생성',
  serverRoom.data.channels?.length === 1 && serverRoom.data.channels[0].name === '일반',
);

const secondChannel = await authFetch(`/api/rooms/${serverId}/channels`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ name: '잡담' }),
});
const secondData = await jsonOrEmpty(secondChannel);
const secondChannelId = secondData.channel?.id;
check('방장이 채널 추가', secondChannel.status === 201 && secondData.channels?.length === 2);

const duplicateChannel = await authFetch(`/api/rooms/${serverId}/channels`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ name: '잡담' }),
});
check('같은 이름 채널은 409', duplicateChannel.status === 409);

const memberChannel = await authFetch(`/api/rooms/${serverId}/channels`, bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ name: '몰래' }),
});
check('일반 참여자는 채널 생성 403', memberChannel.status === 403);

const toSecond = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: serverId, channelId: secondChannelId, text: '잡담 채널 메시지' }),
});
const toDefault = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: serverId, channelId: defaultChannelId, text: '일반 채널 메시지' }),
});
check('채널별 메시지 전송', toSecond.status === 201 && toDefault.status === 201);

const secondHistory = await (
  await authFetch(`/api/messages?room=${serverId}&channelId=${secondChannelId}`, alice.cookie)
).json();
check(
  '채널 메시지가 서로 섞이지 않음',
  secondHistory.messages?.some((message) => message.text === '잡담 채널 메시지') &&
    !secondHistory.messages?.some((message) => message.text === '일반 채널 메시지'),
);

const defaultHistory = await (
  await authFetch(`/api/messages?room=${serverId}&channelId=${defaultChannelId}`, alice.cookie)
).json();
check(
  '기본 채널에는 기본 채널 메시지만',
  defaultHistory.messages?.some((message) => message.text === '일반 채널 메시지') &&
    !defaultHistory.messages?.some((message) => message.text === '잡담 채널 메시지'),
);

const legacyHistory = await (
  await authFetch(`/api/messages?channel=${serverId}`, alice.cookie)
).json();
check(
  '서버 ID로 조회하면 첫 채널을 반환',
  legacyHistory.messages?.some((message) => message.text === '일반 채널 메시지'),
);

const crossChannel = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({
    roomId: publicRoom.data.room.id,
    channelId: secondChannelId,
    text: '다른 방 채널',
  }),
});
check('다른 방의 채널로는 전송 불가 404', crossChannel.status === 404);

const memberDeleteChannel = await authFetch(`/api/channels/${secondChannelId}`, bob.cookie, {
  method: 'DELETE',
});
check('일반 참여자는 채널 삭제 403', memberDeleteChannel.status === 403);

const bobJoinServer = await authFetch(`/api/rooms/${serverId}/join`, bob.cookie, { method: 'POST' });
check('채널 권한 테스트용 입장', bobJoinServer.status === 200);

const grantChannelAdmin = await authFetch(
  `/api/rooms/${serverId}/members/${bob.user.id}/role`,
  alice.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'admin' }) },
);
check('채널 관리자 지정', grantChannelAdmin.status === 200);

const adminChannel = await authFetch(`/api/rooms/${serverId}/channels`, bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ name: '관리자채널' }),
});
const adminChannelData = await jsonOrEmpty(adminChannel);
check('관리자는 채널 생성 가능', adminChannel.status === 201);

const adminDeleteChannel = await authFetch(
  `/api/channels/${adminChannelData.channel?.id}`,
  bob.cookie,
  { method: 'DELETE' },
);
check('관리자는 채널 삭제 가능', adminDeleteChannel.status === 200);

const ownerDeleteSecond = await authFetch(`/api/channels/${secondChannelId}`, alice.cookie, {
  method: 'DELETE',
});
const afterChannelDelete = await jsonOrEmpty(ownerDeleteSecond);
check(
  '채널 삭제 후 목록 갱신',
  ownerDeleteSecond.status === 200 && afterChannelDelete.channels?.length === 1,
);

const lastChannelDelete = await authFetch(`/api/channels/${defaultChannelId}`, alice.cookie, {
  method: 'DELETE',
});
check('마지막 채널은 삭제 불가 400', lastChannelDelete.status === 400);

/* ---------------------------------------------------------------- 읽지 않음 배지 */

const alertChannel = await authFetch(`/api/rooms/${serverId}/channels`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ name: '알림' }),
});
const alertChannelId = (await jsonOrEmpty(alertChannel)).channel?.id;
check('배지 테스트용 채널 생성', alertChannel.status === 201);

const readAlert = await authFetch(`/api/channels/${alertChannelId}/read`, bob.cookie, {
  method: 'POST',
});
check('채널 읽음 처리', readAlert.status === 200);

async function unreadFor(cookie, roomId) {
  const response = await authFetch(`/api/rooms/${roomId}/unread`, cookie);
  const data = await jsonOrEmpty(response);
  return { status: response.status, channels: data.channels ?? [] };
}

function unreadCount(list, channelId) {
  return list.find((item) => item.channelId === channelId)?.unread ?? 0;
}

const baselineUnread = await unreadFor(bob.cookie, serverId);
check('읽음 처리한 채널은 배지 0', unreadCount(baselineUnread.channels, alertChannelId) === 0);
check(
  '입장 전 메시지는 배지에 포함되지 않음',
  unreadCount(baselineUnread.channels, defaultChannelId) === 0,
);

await new Promise((resolve) => setTimeout(resolve, 1500));
const alertOne = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: serverId, channelId: alertChannelId, text: '알림 하나' }),
});
const alertOneData = await jsonOrEmpty(alertOne);
check('배지 테스트 메시지 저장', alertOne.status === 201, String(alertOne.status));

const afterAlert = await unreadFor(bob.cookie, serverId);
check('다른 사람 메시지는 채널 배지로 집계', unreadCount(afterAlert.channels, alertChannelId) === 1);
const alertMark = afterAlert.channels.find((item) => item.channelId === alertChannelId);
check('마지막 읽은 위치를 함께 내려줌', typeof alertMark?.lastReadAt === 'number');
check('읽지 않은 메시지는 읽은 위치보다 뒤', alertMark?.lastReadAt < alertOneData.message.createdAt);
check('다른 채널 배지는 늘지 않음', unreadCount(afterAlert.channels, defaultChannelId) === 0);

await new Promise((resolve) => setTimeout(resolve, 1500));
const bobOwnMessage = await authFetch('/api/messages', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: serverId, channelId: alertChannelId, text: '내가 쓴 알림' }),
});
const bobOwnData = await jsonOrEmpty(bobOwnMessage);
check('배지 테스트 본인 메시지 저장', bobOwnMessage.status === 201, String(bobOwnMessage.status));
const afterOwn = await unreadFor(bob.cookie, serverId);
check(
  '내가 보낸 메시지까지 읽은 위치가 이동',
  (afterOwn.channels.find((item) => item.channelId === alertChannelId)?.lastReadAt ?? 0) >=
    bobOwnData.message.createdAt,
);
check(
  '내가 글을 쓰면 그 채널은 읽음 처리',
  unreadCount(afterOwn.channels, alertChannelId) === 0,
);

await authFetch(`/api/channels/${alertChannelId}/read`, bob.cookie, { method: 'POST' });
const afterRead = await unreadFor(bob.cookie, serverId);
check('채널을 읽으면 배지가 사라짐', unreadCount(afterRead.channels, alertChannelId) === 0);
const readMarkAfter = afterRead.channels.find((item) => item.channelId === alertChannelId);
check('읽은 뒤 위치가 메시지 이후로 이동', readMarkAfter?.lastReadAt >= alertOneData.message.createdAt);

await new Promise((resolve) => setTimeout(resolve, 1500));
await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: serverId, channelId: alertChannelId, text: '알림 둘' }),
});
const afterSecond = await unreadFor(bob.cookie, serverId);
check('새 메시지가 오면 다시 배지 표시', unreadCount(afterSecond.channels, alertChannelId) === 1);

const strangerUnread = await unreadFor(carol.cookie, privateRoom.data.room.id);
check('비멤버는 읽지 않음 정보를 볼 수 없음', strangerUnread.status === 403);

/* ---------------------------------------------------------------- 스크롤 위치 */

async function positionsFor(cookie, roomId) {
  const response = await authFetch(`/api/rooms/${roomId}/positions`, cookie);
  const data = await jsonOrEmpty(response);
  return { status: response.status, positions: data.positions ?? [] };
}

const savePosition = await authFetch(`/api/channels/${alertChannelId}/position`, alice.cookie, {
  method: 'PUT',
  body: JSON.stringify({ scrollTop: 480 }),
});
check('스크롤 위치 저장', savePosition.status === 200);

const alicePositions = await positionsFor(alice.cookie, serverId);
check(
  '저장한 스크롤 위치 조회',
  alicePositions.positions.find((item) => item.channelId === alertChannelId)?.scrollTop === 480,
);

await authFetch(`/api/channels/${alertChannelId}/position`, alice.cookie, {
  method: 'PUT',
  body: JSON.stringify({ scrollTop: 910 }),
});
const alicePositionsUpdated = await positionsFor(alice.cookie, serverId);
check(
  '스크롤 위치 갱신',
  alicePositionsUpdated.positions.find((item) => item.channelId === alertChannelId)?.scrollTop ===
    910,
);

const bobPositions = await positionsFor(bob.cookie, serverId);
check(
  '다른 사용자의 스크롤 위치와 섞이지 않음',
  !bobPositions.positions.some((item) => item.channelId === alertChannelId),
);

const strangerPositions = await positionsFor(carol.cookie, privateRoom.data.room.id);
check('비멤버는 스크롤 위치를 볼 수 없음', strangerPositions.status === 403);

const roomTicket = await ticketFor(bob.cookie, `room:${serverId}`);
check('방 단위 알림 티켓 발급', roomTicket.status === 200);

if (roomTicket.status === 200) {
  const { socket: notifySocket, inbox: notifyInbox } = await openSocket(
    roomTicket.data.websocketUrl,
    ORIGIN,
  );
  await waitForInbox(notifyInbox, (value) => value.type === 'ready');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await authFetch('/api/messages', alice.cookie, {
    method: 'POST',
    body: JSON.stringify({ roomId: serverId, channelId: alertChannelId, text: '실시간 배지 알림' }),
  });
  const notify = await waitForInbox(
    notifyInbox,
    (value) =>
      value.type === 'broadcast' &&
      value.event === 'channel-message' &&
      value.data?.channelId === alertChannelId,
  );
  check('다른 채널 새 글을 방 단위로 즉시 알림', notify.data?.channelId === alertChannelId);
  check('배지 알림에는 메시지 본문이 없음', notify.data?.text === undefined);
  notifySocket.close();
}

/* ---------------------------------------------------------------- 마무리 */

const history = await (
  await authFetch(`/api/messages?channel=${privateRoom.data.room.id}`, alice.cookie)
).json();
check(
  '방 히스토리 조회',
  history.messages?.some((message) => message.text === '초대받고 들어왔어요.'),
);

/* ---------------------------------------------------------------- 관리자 권한 */

const ownerMessage = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: privateRoom.data.room.id, text: '방장이 남긴 메시지' }),
});
const ownerMessageId = (await jsonOrEmpty(ownerMessage)).message?.id;
check('권한 테스트용 방장 메시지', ownerMessage.status === 201);

const memberDeleteOthers = await authFetch(`/api/messages/${ownerMessageId}`, bob.cookie, {
  method: 'DELETE',
});
check('일반 참여자는 남의 메시지 삭제 403', memberDeleteOthers.status === 403);

const ownMessage = await authFetch('/api/messages', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: privateRoom.data.room.id, text: '내가 지울 메시지' }),
});
const ownMessageId = (await jsonOrEmpty(ownMessage)).message?.id;
const selfDelete = await authFetch(`/api/messages/${ownMessageId}`, bob.cookie, {
  method: 'DELETE',
});
check('내 메시지는 직접 삭제 가능', selfDelete.status === 200);

const memberGrant = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${carol.user.id}/role`,
  bob.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'admin' }) },
);
check('방장이 아니면 권한 지정 403', memberGrant.status === 403);

const ownerRoleChange = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${alice.user.id}/role`,
  alice.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'admin' }) },
);
check('방장 자신의 권한은 바꿀 수 없음', ownerRoleChange.status === 400);

const badRole = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${bob.user.id}/role`,
  alice.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'king' }) },
);
check('잘못된 권한 값은 400', badRole.status === 400);

const grantAdmin = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${bob.user.id}/role`,
  alice.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'admin' }) },
);
const grantedMembers = await jsonOrEmpty(grantAdmin);
check(
  '방장이 참여자를 관리자로 지정',
  grantAdmin.status === 200 &&
    grantedMembers.members?.some((member) => member.id === bob.user.id && member.role === 'admin'),
);

const bobDetailAsAdmin = await (
  await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie)
).json();
check('관리자에게 canModerate 부여', bobDetailAsAdmin.canModerate === true && bobDetailAsAdmin.isAdmin === true);

const adminDeleteOthers = await authFetch(`/api/messages/${ownerMessageId}`, bob.cookie, {
  method: 'DELETE',
});
check('관리자는 남의 메시지 삭제 가능', adminDeleteOthers.status === 200);

const deletedMessageCheck = await authFetch(
  `/api/messages?channel=${privateRoom.data.room.id}`,
  alice.cookie,
);
const historyAfterDelete = await jsonOrEmpty(deletedMessageCheck);
check(
  '삭제된 메시지는 히스토리에서 사라짐',
  !historyAfterDelete.messages?.some((message) => message.id === ownerMessageId),
);

const logAsOwner = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/moderation`,
  alice.cookie,
);
const logData = await jsonOrEmpty(logAsOwner);
check('방장이 삭제 기록 조회', logAsOwner.status === 200);
check(
  '삭제 기록에 삭제자·작성자·내용 기록',
  logData.entries?.some(
    (entry) =>
      entry.actorId === bob.user.id &&
      entry.authorId === alice.user.id &&
      entry.messageText === '방장이 남긴 메시지',
  ),
);
check(
  '본인 메시지 삭제는 기록되지 않음',
  !logData.entries?.some((entry) => entry.messageText === '내가 지울 메시지'),
);

const logAsAdmin = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/moderation`,
  bob.cookie,
);
check('관리자는 삭제 기록 조회 불가 403', logAsAdmin.status === 403);

const logAsStranger = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/moderation`,
  carol.cookie,
);
check('비멤버는 삭제 기록 조회 불가 403', logAsStranger.status === 403);

const adminPatch = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie, {
  method: 'PATCH',
  body: JSON.stringify({ name: '관리자 변경 시도', description: '', visibility: 'public' }),
});
check('관리자도 방 설정은 변경 불가 403', adminPatch.status === 403);

const adminRemoveMember = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${alice.user.id}`,
  bob.cookie,
  { method: 'DELETE' },
);
check('관리자도 참여자 내보내기 불가 403', adminRemoveMember.status === 403);

const revokeTarget = await authFetch('/api/messages', alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: privateRoom.data.room.id, text: '권한 회수 테스트' }),
});
const revokeTargetId = (await jsonOrEmpty(revokeTarget)).message?.id;
check('권한 회수 테스트 메시지 저장', revokeTarget.status === 201, String(revokeTarget.status));

const revokeAdmin = await authFetch(
  `/api/rooms/${privateRoom.data.room.id}/members/${bob.user.id}/role`,
  alice.cookie,
  { method: 'POST', body: JSON.stringify({ role: 'member' }) },
);
check('관리자 해제', revokeAdmin.status === 200);

const afterRevoke = await authFetch(`/api/messages/${revokeTargetId}`, bob.cookie, {
  method: 'DELETE',
});
check('해제된 사용자는 다시 삭제 403', afterRevoke.status === 403, String(afterRevoke.status));

/* ---------------------------------------------------------------- 방장 넘기기 */

const transferRoom = await createRoom(alice.cookie, {
  name: `넘기기방 ${stamp}`,
  visibility: 'public',
});
check('방장 넘기기용 방 생성', transferRoom.status === 201);
const transferRoomId = transferRoom.data.room.id;

const carolJoinTransfer = await authFetch(`/api/rooms/${transferRoomId}/join`, carol.cookie, {
  method: 'POST',
});
check('넘기기방에 참여자 입장', carolJoinTransfer.status === 200);

const strangerTransfer = await authFetch(`/api/rooms/${transferRoomId}/owner`, bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: carol.user.id }),
});
check('방장이 아니면 방장 넘기기 403', strangerTransfer.status === 403);

const transferToNonMember = await authFetch(`/api/rooms/${transferRoomId}/owner`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: bob.user.id }),
});
check('참여자가 아니면 방장 넘기기 400', transferToNonMember.status === 400);

const transferToSelf = await authFetch(`/api/rooms/${transferRoomId}/owner`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: alice.user.id }),
});
check('자기 자신에게는 넘길 수 없음', transferToSelf.status === 400);

const transfer = await authFetch(`/api/rooms/${transferRoomId}/owner`, alice.cookie, {
  method: 'POST',
  body: JSON.stringify({ userId: carol.user.id }),
});
const transferData = await jsonOrEmpty(transfer);
check(
  '방장 넘기기 성공',
  transfer.status === 200 && transferData.isOwner === false && transferData.isMember === true,
);

const aliceAfterTransfer = await (
  await authFetch(`/api/rooms/${transferRoomId}`, alice.cookie)
).json();
check(
  '넘긴 뒤 이전 방장은 권한과 코드 상실',
  aliceAfterTransfer.isOwner === false && aliceAfterTransfer.room?.code === undefined,
);

const carolAfterTransfer = await (
  await authFetch(`/api/rooms/${transferRoomId}`, carol.cookie)
).json();
check(
  '새 방장에게 코드 노출',
  carolAfterTransfer.isOwner === true &&
    carolAfterTransfer.room?.code === transferRoom.data.room.code,
);

const oldOwnerPatch = await authFetch(`/api/rooms/${transferRoomId}`, alice.cookie, {
  method: 'PATCH',
  body: JSON.stringify({ name: '가로채기', description: '', visibility: 'public' }),
});
check('넘긴 뒤 이전 방장 설정 변경 403', oldOwnerPatch.status === 403);

const newOwnerLeave = await authFetch(`/api/rooms/${transferRoomId}/leave`, carol.cookie, {
  method: 'POST',
});
check('새 방장은 방을 나갈 수 없음', newOwnerLeave.status === 400);

const oldOwnerLeave = await authFetch(`/api/rooms/${transferRoomId}/leave`, alice.cookie, {
  method: 'POST',
});
check('넘긴 뒤 이전 방장은 나가기 가능', oldOwnerLeave.status === 200);

const newOwnerDelete = await authFetch(`/api/rooms/${transferRoomId}`, carol.cookie, {
  method: 'DELETE',
});
check('새 방장은 방 삭제 가능', newOwnerDelete.status === 200);

/* ---------------------------------------------------------------- 나가기·삭제 */

const publicDetailBefore = await (
  await authFetch(`/api/rooms/${publicRoom.data.room.id}`, bob.cookie)
).json();
check('공개방 상세는 비멤버도 조회 가능', publicDetailBefore.isMember === false);

const publicJoin = await authFetch(`/api/rooms/${publicRoom.data.room.id}/join`, bob.cookie, {
  method: 'POST',
});
check('공개방은 ID로 입장', publicJoin.status === 200);

const publicDetailAfter = await (
  await authFetch(`/api/rooms/${publicRoom.data.room.id}`, bob.cookie)
).json();
check('공개방 입장 후 멤버로 표시', publicDetailAfter.isMember === true);

const publicLeave = await authFetch(`/api/rooms/${publicRoom.data.room.id}/leave`, bob.cookie, {
  method: 'POST',
});
check('공개방 나가기', publicLeave.status === 200);

const publicAfterLeave = await (
  await authFetch(`/api/rooms/${publicRoom.data.room.id}`, bob.cookie)
).json();
check('공개방을 나간 뒤 비멤버', publicAfterLeave.isMember === false);

const inviteJoinById = await authFetch(`/api/rooms/${inviteRoom.data.room.id}/join`, carol.cookie, {
  method: 'POST',
});
check('초대방은 코드 없이 ID 입장 불가', inviteJoinById.status === 403);

const bobLeave = await authFetch(`/api/rooms/${privateRoom.data.room.id}/leave`, bob.cookie, {
  method: 'POST',
});
check('참여자가 방 나가기', bobLeave.status === 200);

const bobAfterLeave = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, bob.cookie);
check('나간 뒤 비공개방 접근 차단', bobAfterLeave.status === 403);

const bobLeaveAgain = await authFetch(`/api/rooms/${privateRoom.data.room.id}/leave`, bob.cookie, {
  method: 'POST',
});
check('이미 나간 방은 다시 나갈 수 없음', bobLeaveAgain.status === 400);

const ownerLeave = await authFetch(`/api/rooms/${privateRoom.data.room.id}/leave`, alice.cookie, {
  method: 'POST',
});
check('방장은 방을 나갈 수 없음', ownerLeave.status === 400);

const bobDelete = await authFetch(`/api/rooms/${publicRoom.data.room.id}`, bob.cookie, {
  method: 'DELETE',
});
check('방장이 아니면 방 삭제 403', bobDelete.status === 403);

const carolDelete = await authFetch(`/api/rooms/${privateRoom.data.room.id}`, carol.cookie, {
  method: 'DELETE',
});
check('비멤버의 방 삭제 403', carolDelete.status === 403);

const ownerDelete = await authFetch(`/api/rooms/${publicRoom.data.room.id}`, alice.cookie, {
  method: 'DELETE',
});
check('방장은 방을 삭제할 수 있음', ownerDelete.status === 200);

const deletedDetail = await authFetch(`/api/rooms/${publicRoom.data.room.id}`, alice.cookie);
check('삭제된 방 상세는 404', deletedDetail.status === 404);

const deletedMessage = await authFetch('/api/messages', carol.cookie, {
  method: 'POST',
  body: JSON.stringify({ roomId: publicRoom.data.room.id, text: '삭제된 방 메시지' }),
});
check('삭제된 방에는 메시지 전송 불가', deletedMessage.status === 404, String(deletedMessage.status));

const bobLobbyAfterDelete = await (await authFetch('/api/rooms', bob.cookie)).json();
check(
  '삭제된 방은 로비에서 사라짐',
  !bobLobbyAfterDelete.rooms?.some((room) => room.id === publicRoom.data.room.id),
);

const globalSend = await authFetch('/api/messages', bob.cookie, {
  method: 'POST',
  body: JSON.stringify({ text: '글로벌 인사' }),
});
check('글로벌 메시지 저장', globalSend.status === 201);

const logoutResponse = await authFetch('/api/logout', bob.cookie, { method: 'POST' });
const cleared = (logoutResponse.headers.getSetCookie?.() ?? []).some((value) =>
  value.includes('Max-Age=0'),
);
check('로그아웃 쿠키 삭제', logoutResponse.ok && cleared);

if (failures) {
  console.error(`\n${failures}개 테스트 실패`);
  process.exit(1);
}

console.log('\n모든 스모크 테스트 통과');
process.exit(0);
