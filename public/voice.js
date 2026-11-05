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

  const noop = () => {};

  const isOfferer = (peerId) => selfId < peerId;

  function snapshot() {
    const people = [
      {
        id: selfId,
        nickname: me.nickname,
        self: true,
        mic: micOn,
        screen: screenOn,
        videoStream: screenOn && screenStream ? screenStream : null,
      },
    ];
    for (const [peerId, peer] of peers) {
      people.push({
        id: peerId,
        nickname: presence.get(peerId)?.nickname || peerId,
        self: false,
        mic: presence.get(peerId)?.mic !== false,
        screen: Boolean(peer.stream.getVideoTracks().length),
        videoStream: peer.stream.getVideoTracks().length ? peer.stream : null,
      });
    }
    return {
      status,
      statusLabel: STATUS_LABEL[status] ?? status,
      micOn,
      screenOn,
      count: people.length,
      participants: people,
      canShareScreen: Boolean(navigator.mediaDevices?.getDisplayMedia),
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

    const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    peer.audioSender = audioTx.sender;
    peer.videoSender = videoTx.sender;
    if (micStream?.getAudioTracks()[0]) peer.audioSender.replaceTrack(micStream.getAudioTracks()[0]).catch(noop);
    if (screenStream?.getVideoTracks()[0]) peer.videoSender.replaceTrack(screenStream.getVideoTracks()[0]).catch(noop);

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
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await signal('offer', peerId, { sdp: peer.pc.localDescription.toJSON() });
    } catch {
      // 다음 presence 갱신에서 다시 시도한다.
    } finally {
      peer.makingOffer = false;
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
      try {
        await peer.pc.setRemoteDescription(payload.sdp);
        await flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await signal('answer', peerId, { sdp: peer.pc.localDescription.toJSON() });
      } catch {
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
      } catch {
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
      for (const peer of peers.values()) {
        await peer.audioSender.replaceTrack(micStream.getAudioTracks()[0]).catch(noop);
      }
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

    await acquireMic();

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
              if (!before && isOfferer(member.userId)) offerTo(member.userId).catch(noop);
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
    if (!navigator.mediaDevices?.getDisplayMedia) {
      onNotice('이 브라우저에서는 화면 공유를 지원하지 않아요.');
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
    } catch {
      onNotice('화면 공유가 취소되었어요.');
      return;
    }

    const track = screenStream.getVideoTracks()[0];
    track.onended = () => {
      stopScreen().catch(noop);
    };
    screenOn = true;
    for (const peer of peers.values()) {
      await peer.videoSender.replaceTrack(track).catch(noop);
    }
    sendPresence();
    signal('screen', null, { on: true });
    emit();
  }

  async function stopScreen() {
    if (!screenOn) return;
    screenOn = false;
    for (const track of screenStream?.getTracks() ?? []) track.stop();
    screenStream = null;
    for (const peer of peers.values()) {
      await peer.videoSender.replaceTrack(null).catch(noop);
    }
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
