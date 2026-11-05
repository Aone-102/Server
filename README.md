# 링크챗 (LinkChat)

링크 하나만 공유하면 누구나 들어와서 대화할 수 있는 오픈 채팅입니다.
초대 코드, 이메일 가입, 앱 설치 없이 **아이디 + 닉네임**만 정하면 바로 입장합니다.

- 공개 주소: <https://site-c2acfaafd335463a81437c5c3557d549.freebuff.page>
- 실행 환경: Cloudflare Workers (Freebuff Sites) · D1 · Sites realtime

```
링크 공유 → 아이디/닉네임 설정 → 로비(방 목록 · 방 만들기 · 코드 입장 · 친구)
        → 글로벌 채팅 / 방 채팅 / 방 설정(방장)
```

## 기능

### 방 공개 범위

방을 만들 때 정하고, **방장만** 방 설정에서 바꿀 수 있습니다.

| 범위 | 로비 노출 | 입장 조건 |
| --- | --- | --- |
| 공개방 | 보임 | 누구나 (링크 공유) |
| 친구 초대방 | 숨김 | 방 코드를 받은 사람 |
| 비공개방 | 숨김 | 방장이 친구로 초대한 사람 |

- 방마다 **6자리 방 코드**가 자동 발급되고, 방 설정에서 확인·복사할 수 있습니다.
- 코드 입장은 로비의 `코드로 입장` 버튼이나 `/?code=XXXXXX` 링크로 합니다.
- 비공개방은 코드만으로 들어갈 수 없고, 방장이 친구를 초대해야 합니다.
- 서버가 멤버십을 확인하므로 비멤버는 메시지·실시간 접속이 모두 403으로 차단됩니다.

### 친구

- 아이디로 친구 요청 → 상대가 수락하면 양쪽 친구 목록에 추가됩니다.
- 서로 요청이 엇갈리면 자동으로 수락됩니다.
- 친구는 비공개방 초대 목록에 나타나고, 방장이 초대/내보내기를 할 수 있습니다.

### 음성 · 화면공유

- 방 안에서 `음성` 버튼을 누르면 마이크로 참여하고, 참여자 타일이 뜹니다.
- `화면 공유`를 누르면 브라우저 화면을 공유하고, 공유 타일은 더블클릭으로 전체 화면이 됩니다.
- 미디어는 WebRTC P2P로 흐르고, SDP/ICE 교환만 서버(`voice:<방ID>`)로 중계합니다.
- 공유 화면은 `+`/`−` 버튼으로 1~3배 확대할 수 있고, 채팅 글자도 헤더의 `A−`/`A+`로 85~160% 조절됩니다(설정 유지).
- 마이크·화면 권한이 없으면 해당 기능만 꺼지고 나머지는 그대로 동작합니다.

### 테마

- 기본은 **밝은(흰색) 화면**이고, 오른쪽 위 버튼으로 다크 모드로 전환합니다.
- 선택은 `localStorage`에 저장되어 다음 방문에도 유지됩니다.

## 구조

```
worker.js                Worker 진입점 — REST API, D1, 실시간 티켓/발행, 정적 자산
public/index.html        로그인 · 로비 · 채팅 · 방 설정 · 친구 UI
public/app.js            클라이언트 (HTTP + 실시간 + 폴링 폴백, 테마)
public/realtime.js       Sites realtime 브라우저 클라이언트
public/styles.css        라이트/다크 테마, 반응형 레이아웃
wrangler.jsonc           로컬 개발 설정 (로컬 D1, realtime 헬퍼 바인딩)
deploy.manifest.json     Sites 배포 매니페스트 (realtime: true)
scripts/smoke.mjs        HTTP + WebSocket 통합 스모크 테스트
freebuff-realtime/       로컬 실시간 헬퍼 (테스트 전용, 배포에 포함되지 않음)
```

## 로컬 실행

```bash
npm install

# 터미널 1 — 실시간 헬퍼 (127.0.0.1:8788)
npm run realtime

# 터미널 2 — 앱 (http://127.0.0.1:3000)
npm run dev

# 터미널 3 — 검증
npm run smoke
```

실시간 헬퍼 없이 `npm run dev`만 실행해도 앱은 동작합니다. 이때는 실시간 티켓이
503을 돌려주고 클라이언트가 2.5초 폴링으로 자동 전환됩니다.

## 배포

Sites에 D1(`DB`)을 붙인 뒤 매니페스트로 배포합니다. D1 스키마와 마이그레이션은
첫 API 요청에서 자동 적용됩니다(`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`,
이미 적용된 마이그레이션은 무시).

```bash
sites_add_storage  production DB
sites_deploy       production deploy.manifest.json
```

세션 서명 키는 `SESSION_SECRET` 환경변수가 있으면 그것을, 없으면 D1 `meta` 테이블에
자동 생성해 보관합니다.

## REST API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/login` | `{ userId, nickname }` → 세션 쿠키(30일) |
| `POST` | `/api/logout` | 세션 쿠키 삭제 |
| `GET` | `/api/me` | 현재 로그인 사용자 |
| `GET` | `/api/rooms?q=` | 공개방 + 내가 속한 방 목록 (최근 메시지 포함) |
| `POST` | `/api/rooms` | `{ name, description, visibility }` → 방 생성(코드 자동 발급) |
| `GET` | `/api/rooms/:id` | 방 상세 (방장에게만 `code` 포함, 멤버 목록) |
| `PATCH` | `/api/rooms/:id` | 방장 전용 설정 변경 |
| `POST` | `/api/rooms/:id/join` | 방 ID로 입장 (공개방만 — 초대·비공개방은 코드나 초대 필요) |
| `POST` | `/api/rooms/join` | `{ code }` → 코드로 입장 |
| `POST` | `/api/rooms/:id/owner` | 방장 전용 방장 넘기기 `{ userId }` (같은 방 참여자만, 넘기면 이전 방장은 일반 참여자가 됨) |
| `POST` | `/api/rooms/:id/leave` | 참여자가 방 나가기 (방장은 삭제만 가능) |
| `DELETE` | `/api/rooms/:id` | 방장 전용 방 삭제 (메시지·멤버 정리 후 `room-deleted` 발행) |
| `POST` | `/api/rooms/:id/members/:userId/role` | 방장 전용 권한 지정 `{ role: 'admin' \| 'member' }` |
| `POST` | `/api/rooms/:id/channels` | 방장·관리자가 채널 생성 `{ name }` (기본 `일반` 채널 자동 생성) |
| `DELETE` | `/api/channels/:id` | 방장·관리자가 채널 삭제 (마지막 채널은 불가) |
| `GET` | `/api/rooms/:id/unread` | 채널별 읽지 않은 메시지 수 + 마지막 읽은 위치 `lastReadAt` (내가 쓴 메시지·입장 전 메시지 제외) |
| `POST` | `/api/channels/:id/read` | 해당 채널을 읽음으로 표시 → 배지 초기화 |
| `GET` | `/api/rooms/:id/positions` | 내 채널별 스크롤 위치 (기기 간 동기화용) |
| `PUT` | `/api/channels/:id/position` | `{ scrollTop }` → 스크롤 위치 저장 |
| `DELETE` | `/api/messages/:id` | 내 메시지 또는 방장·관리자가 메시지 삭제 (`message-deleted` 발행) |
| `GET` | `/api/rooms/:id/moderation` | 방장 전용 삭제 기록 (누가 누구의 어떤 메시지를 지웠는지, 최근 50개) |
| `POST` | `/api/rooms/:id/members` | 방장이 친구 초대 `{ userId }` |
| `DELETE` | `/api/rooms/:id/members/:userId` | 방장이 내보내기 |
| `GET` | `/api/messages?channel=global` \| `?room=:roomId&channelId=:channelId` | 채널 스냅샷(최근 60개) 또는 `after`/`afterId` 증분 조회 |
| `POST` | `/api/messages` | `{ roomId, channelId, text }` → 저장 후 해당 채널로 실시간 발행 |
| `GET` | `/api/friends` | 친구 / 받은 요청 / 보낸 요청 |
| `POST` | `/api/friends/requests` | `{ userId }` → 친구 요청 |
| `POST` | `/api/friends/requests/:id/respond` | `{ action: 'accept' \| 'decline' }` |
| `DELETE` | `/api/friends/:userId` | 친구 삭제 |
| `POST` | `/api/rooms/:id/voice/signal` | `{ kind, to, payload }` → WebRTC 시그널(SDP/ICE) 중계 |
| `POST` | `/api/realtime/ticket` | `{ room }` → 실시간 접속 티켓 (방 접근 권한 확인, `voice:<방ID>` 포함) |
| `GET` | `/healthz` | 헬스 체크 |

## 실시간 동작

- 방 이름은 `global`, `room:<방ID>`, `ch:<채널ID>`이며, 티켓은 로그인 쿠키 + 방 접근 권한으로만 발급됩니다.
  브라우저는 `userId`·권한을 지정할 수 없고 서버가 결정합니다(`publish: false`, `presence: true`).
- 메시지는 **D1에 먼저 저장한 뒤** `publishRealtime` 으로 브로드캐스트합니다.
  브로드캐스트는 휘발성이므로 재접속(`ready`) 때마다 스냅샷을 다시 읽습니다.
- 프레즌스는 `{ nickname }` 만 공유하며, 화면에는 현재 채널의 참여 인원이 표시됩니다.
- 채널 목록의 읽지 않음 배지는 보고 있지 않은 채널에 글이 오면 `room:<방ID>` 스코프의
  `channel-message` 이벤트(본문 미포함: `channelId`, `userId`, `createdAt`)로 즉시 올라갑니다.
  놓친 이벤트는 재연결·창 포커스 시 `GET /api/rooms/:id/unread` 로 한 번 맞춥니다.
- 실시간 연결이 끊기면 자동 재연결 + 백오프, 그동안은 폴링이 메시지를 따라잡습니다.

## 제약과 보안

- 실시간 한도: 방당 32 연결, 환경 전체 128 연결 / 32개 방. 메시지 16KiB.
- 메시지는 최대 1,000자, 전송 속도는 사용자당 버킷 5개로 제한됩니다.
- 본문은 항상 `textContent` 로 렌더링해 XSS가 성립하지 않습니다.
- 상태 변경 요청은 `Origin` 검사 + `SameSite=Lax` 쿠키로 보호됩니다.
- 로그인은 **비밀번호 없는 게스트 방식**입니다. 아이디를 아는 사람은 같은 아이디로
  입장할 수 있으므로, 공개 서비스로 키우려면 비밀번호/OAuth를 추가해야 합니다.
- 공개방은 멤버가 아니어도 읽고 쓸 수 있고, 초대/비공개방만 멤버십을 검사합니다.

## 다음 단계 후보

- 비밀번호/소셜 로그인, 닉네임 변경
- 방 삭제, 방장 위임, 관리자 기능
- 읽음 표시, 타이핑 인디케이터, 멘션
- 메시지 페이지네이션(무한 스크롤), D1 보존 정책
