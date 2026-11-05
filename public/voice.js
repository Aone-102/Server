// 음성·화면공유 (WebRTC 메시 + 서버 시그널링)
// - 미디어는 브라우저 간 P2P로 흐르고, SDP/ICE 교환만 /api/rooms/:id/voice/signal 로 중계한다.
// - 마이크/화면 트랙은 처음 만든 transceiver의 sender.replaceTrack()으로 갈아끼워
//   재협상 없이 켜고 끌 수 있다.
import { connectRealtime } from './realtime.js';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const STATUS_LABEL = {
  idle: '대기 중',
  connecting: '연결 중…',
  joined: '참여 중',
  disconnected: '연결이 끊겼어요',
  unauthorized: '입장 권한이 없어요',
  error: '연결할 수 없어요',
};

export function createVoice({ roomId, me, onState = () => {}, onNotice = () => {} }) {
  const selfId = me.id;
  const peers = new Map();
  const presence = new Map();
  let realtime = null;
  let status = 'idle';
  let joined = false;
  let closed = false;
  let micStream = null;
  let screenStream = null;
  let micOn = false;
  let screenOn = false;
  let screenKind = null;

  const noop = () => {};

  // 협상 전에도 m-line이 sendrecv가 되도록 무음/검정 트랙을 먼저 붙여 둔다.
  // 실제 마이크·화면은 replaceTrack으로 갈아끼우므로 재협상이 필요 없다.
  let placeholderVideo = null;
  let placeholderAudio = null;
  let placeholderOsc = null;

  function placeholderVideoTrack() {
    if (!placeholderVideo) {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext('2d').fillRect(0, 0, 2, 2);
      placeholderVideo = canvas.captureStream(1);
    }
    return placeholderVideo.getVideoTracks()[0] ?? null;
  }

  function placeholderAudioTrack() {
    if (placeholderAudio) return placeholderAudio.getAudioTracks()[0] ?? null;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      placeholderOsc = ctx.createOscillator();
      placeholderOsc.connect(gain);
      gain.connect(dest);
      placeholderOsc.start();
      ctx.resume().catch(noop);
      placeholderAudio = dest.stream;
    } catch {
      placeholderAudio = null;
    }
    return placeholderAudio?.getAudioTracks()[0] ?? null;
  }

  // id가 숫자/문자열로 섞여도 비교가 NaN이 되지 않게 문자열로 맞춘다.
  const isOfferer = (peerId) => String(selfId) < String(peerId);

  function snapshot() {
    const people = [
      {
        id: selfId,
        nickname: me.nickname,
        self: true,
        mic: micOn,
        screen: screenOn,
        screenKind,
        videoStream: screenOn && screenStream ? screenStream : null,
        audioStream: null,
      },
    ];
    for (const [peerId, peer] of peers) {
      const info = presence.get(peerId) ?? {};
      const sharing = info.screen === true;
      people.push({
        id: peerId,
        nickname: info.nickname || peerId,
        self: false,
        mic: info.mic !== false,
        screen: sharing,
        screenKind: 'display',
        videoStream: sharing ? peer.stream : null,
        audioStream: peer.stream.getAudioTracks().length ? peer.stream : null,
      });
    }
    return {
      status,
      statusLabel: STATUS_LABEL[status] ?? status,
      micOn,
      screenOn,
      count: people.length,
      participants: people,
      canShareScreen: Boolean(
        navigator.mediaDevices?.getDisplayMedia || navigator.mediaDevices?.getUserMedia,
      ),
    };
  }

  function emit() {
    if (!closed) onState(snapshot());
  }

  async function signal(kind, to, payload = null) {
    try {
      await fetch(`/api/rooms/${encodeURIComponent(roomId)}/voice/signal`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, to, payload }),
      });
    } catch {
      // 시그널링이 잠시 실패해도 ICE가 다시 오면 회복된다.
    }
  }

  function sendPresence() {
    realtime?.presence({ nickname: me.nickname, mic: micOn, screen: screenOn });
  }

  function ensurePeer(peerId) {
    const existing = peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const stream = new MediaStream();
    const peer = { id: peerId, pc, stream, pending: [], makingOffer: false };

    pc.onicecandidate = (event) => {
      if (event.candidate) signal('ice', peerId, { candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track);
      }
      emit();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.restartIce?.();
      }
      emit();
    };

    peers.set(peerId, peer);
    emit();
    return peer;
  }

  // 로컬 트랙을 m-line에 붙인다. offerer는 offer 전에, answerer는 remote offer를
  // 적용한 뒤 호출해야 트랜시버가 중복 생성되지 않고 sendrecv로 협상된다.
  function attachLocalMedia(peer) {
    peer.senders = peer.senders ?? {};
    const audio = micStream?.getAudioTracks()[0] ?? placeholderAudioTrack();
    const video = screenStream?.getVideoTracks()[0] ?? placeholderVideoTrack();
    if (audio && !peer.senders.audio) peer.senders.audio = peer.pc.addTrack(audio);
    if (video && !peer.senders.video) peer.senders.video = peer.pc.addTrack(video);
  }

  async function flushCandidates(peer) {
    for (const candidate of peer.pending.splice(0)) {
      await peer.pc.addIceCandidate(candidate).catch(noop);
    }
  }

  async function offerTo(peerId) {
    const peer = ensurePeer(peerId);
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      attachLocalMedia(peer);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await signal('offer', peerId, { sdp: peer.pc.localDescription.toJSON() });
    } catch (error) {
      console.warn('[voice] offer failed', String(error));
    } finally {
      peer.makingOffer = false;
    }
  }

  // 공유 시작/중지·마이크 지연 연결처럼 송신 트랙 구성이 바뀔 때는
  // 피어 연결을 새로 만들어(트랙 포함) 협상을 다시 한다.
  async function restartPeers() {
    for (const peerId of [...peers.keys()]) {
      dropPeer(peerId);
      if (isOfferer(peerId)) await offerTo(peerId);
      else await signal('renegotiate', peerId);
    }
  }

  function dropPeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      // 이미 닫힌 연결은 무시한다.
    }
    peers.delete(peerId);
    presence.delete(peerId);
    emit();
  }

  async function handleSignal(message) {
    if (message.to && message.to !== selfId) return;
    if (!message.from || message.from === selfId) return;
    const peerId = message.from;
    const kind = message.kind;
    const payload = message.payload ?? {};

    if (kind === 'offer') {
      const peer = ensurePeer(peerId);
      // 양쪽이 동시에 offer를 만든 경우(glare): offerer가 아닌 쪽이 되돌린다.
      if (peer.makingOffer || peer.pc.signalingState !== 'stable') {
        if (isOfferer(peerId)) return;
        await peer.pc.setLocalDescription({ type: 'rollback' }).catch(noop);
      }
      try {
        await peer.pc.setRemoteDescription(payload.sdp);
        await flushCandidates(peer);
        attachLocalMedia(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await signal('answer', peerId, { sdp: peer.pc.localDescription.toJSON() });
      } catch (error) {
        console.warn('[voice] answer failed', String(error));
        dropPeer(peerId);
      }
      return;
    }

    if (kind === 'answer') {
      const peer = peers.get(peerId);
      if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
      try {
        await peer.pc.setRemoteDescription(payload.sdp);
        await flushCandidates(peer);
      } catch (error) {
        console.warn('[voice] set answer failed', String(error));
        dropPeer(peerId);
      }
      return;
    }

    if (kind === 'ice') {
      if (!payload.candidate) return;
      const peer = ensurePeer(peerId);
      if (!peer.pc.remoteDescription) {
        peer.pending.push(payload.candidate);
        return;
      }
      await peer.pc.addIceCandidate(payload.candidate).catch(noop);
      return;
    }

    if (kind === 'leave') {
      dropPeer(peerId);
      return;
    }

    if (kind === 'renegotiate') {
      dropPeer(peerId);
      if (isOfferer(peerId)) offerTo(peerId).catch(noop);
      return;
    }

    if (kind === 'mic' || kind === 'screen') {
      const person = presence.get(peerId) ?? { nickname: peerId, mic: true, screen: false };
      person[kind] = payload.on !== false;
      presence.set(peerId, person);
      emit();
    }
  }

  async function acquireMic() {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      for (const track of micStream.getAudioTracks()) track.enabled = true;
      micOn = true;
      restartPeers().catch(noop);
      return true;
    } catch {
      micOn = false;
      onNotice('마이크를 켤 수 없어요. 브라우저 권한을 확인해 주세요.');
      return false;
    }
  }

  async function join() {
    if (joined) return;
    joined = true;
    closed = false;
    status = 'connecting';
    emit();

    // 마이크 권한 응답을 기다리지 않고 먼저 연결한다. 권한이 없어도 서로 보이고,
    // 허용되면 트랙만 나중에 붙는다.
    acquireMic()
      .then(() => {
        if (closed) return;
        sendPresence();
        emit();
      })
      .catch(noop);

    try {
      realtime = connectRealtime({
        room: `voice:${roomId}`,
        onStatus(next) {
          if (closed) return;
          if (next === 'connected') {
            status = 'joined';
            sendPresence();
            emit();
            for (const peerId of presence.keys()) {
              if (isOfferer(peerId)) offerTo(peerId).catch(noop);
            }
          } else if (next === 'unauthorized') {
            status = 'unauthorized';
            emit();
          } else if (next === 'disconnected') {
            status = 'disconnected';
            emit();
          }
        },
        onMessage(message) {
          if (closed) return;
          if (message.type === 'presence') {
            const seen = new Set();
            for (const member of message.members ?? []) {
              if (!member.userId || member.userId === selfId) continue;
              seen.add(member.userId);
              const before = presence.get(member.userId);
              presence.set(member.userId, {
                nickname: member.data?.nickname || member.userId,
                mic: member.data?.mic !== false,
                screen: member.data?.screen === true,
              });
              if (!before) {
                if (isOfferer(member.userId)) {
                  offerTo(member.userId).catch(noop);
                } else {
                  // offerer 판정이 어긋나도 연결이 멈추지 않도록 지연 offer를 건다.
                  setTimeout(() => {
                    const peer = peers.get(member.userId);
                    if (!peer || (!peer.pc.remoteDescription && !peer.makingOffer)) {
                      offerTo(member.userId).catch(noop);
                    }
                  }, 2500);
                }
              }
            }
            for (const peerId of [...peers.keys()]) {
              if (!seen.has(peerId)) dropPeer(peerId);
            }
            emit();
            return;
          }
          if (message.type === 'broadcast' && message.event === 'voice-signal') {
            handleSignal(message.data ?? {}).catch(noop);
          }
        },
      });
    } catch {
      status = 'error';
      emit();
    }
  }

  async function toggleMic() {
    if (!micOn) {
      await acquireMic();
      sendPresence();
      emit();
      return;
    }
    micOn = false;
    for (const track of micStream?.getAudioTracks() ?? []) track.enabled = false;
    sendPresence();
    signal('mic', null, { on: false });
    emit();
  }

  async function startScreen() {
    if (screenOn) return;

    let nextStream = null;
    let kind = 'display';

    if (navigator.mediaDevices?.getDisplayMedia) {
      try {
        nextStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 15 },
          audio: false,
        });
      } catch {
        onNotice('화면 공유가 취소되었어요.');
        return;
      }
    } else if (navigator.mediaDevices?.getUserMedia) {
      // 휴대폰 브라우저에는 화면 캡처 API가 없어 카메라로 대신 공유한다.
      try {
        nextStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        kind = 'camera';
        onNotice('휴대폰에서는 화면 대신 카메라를 공유해요.');
      } catch {
        onNotice('공유를 시작할 수 없어요. 브라우저 권한을 확인해 주세요.');
        return;
      }
    } else {
      onNotice('이 브라우저에서는 공유를 지원하지 않아요.');
      return;
    }

    screenStream = nextStream;
    screenKind = kind;
    const track = screenStream.getVideoTracks()[0];
    track.onended = () => {
      stopScreen().catch(noop);
    };
    screenOn = true;
    sendPresence();
    await restartPeers();
    signal('screen', null, { on: true });
    emit();
  }

  async function stopScreen() {
    if (!screenOn) return;
    screenOn = false;
    for (const track of screenStream?.getTracks() ?? []) track.stop();
    screenStream = null;
    screenKind = null;
    sendPresence();
    signal('screen', null, { on: false });
    emit();
  }

  async function leave() {
    if (!joined) return;
    closed = true;
    joined = false;
    await signal('leave', null);
    realtime?.close();
    realtime = null;
    for (const track of micStream?.getTracks() ?? []) track.stop();
    for (const track of screenStream?.getTracks() ?? []) track.stop();
    micStream = null;
    screenStream = null;
    for (const peerId of [...peers.keys()]) dropPeer(peerId);
    status = 'idle';
    micOn = false;
    screenOn = false;
    screenKind = null;
    emit();
  }

  return {
    join,
    leave,
    toggleMic,
    startScreen,
    stopScreen,
    snapshot,
    get joined() {
      return joined;
    },
  };
}
