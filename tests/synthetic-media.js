"use strict";
// Test-only capture adapter. Audio/ICE/RTP/codec negotiation remain native.
// Reported processing switches here are a stub, not hardware audio evidence.
(() => {
  const mode = new URLSearchParams(location.search).get("mode");
  const state = window.testMedia = {requests: [], tracks: [], contexts: [], errors: [], collisions: 0};
  document.addEventListener("DOMContentLoaded", () => {
    // Allows the same local harness to compare an unmodified baseline app.js.
    // This observer does not configure baseline senders or alter negotiation.
    if (!window.voiceDiagnostics && window.VoiceAudio) {
      const observed = new WeakMap();
      window.VoiceAudio.create({getPeers: () => state.connections.filter(pc => pc.connectionState !== "closed").map(pc => {
        if (!observed.has(pc)) observed.set(pc, {pc});
        return observed.get(pc);
      })});
    }
  });
  window.addEventListener("error", e => state.errors.push(e.message));
  window.addEventListener("unhandledrejection", e => state.errors.push(String(e.reason)));
  localStorage.removeItem("boundary-tales-audio-v1");
  const NativePeerConnection = window.RTCPeerConnection;
  state.connections = [];
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(...args) {
      super(...args); state.connections.push(this);
      if (new URLSearchParams(location.search).get("loopback") === "1") {
        this.addEventListener("icecandidate", event => {
          if (!event.candidate) return;
          const original = event.candidate.toJSON();
          const fields = original.candidate.split(/\s+/);
          if (fields[2]?.toLowerCase() === "udp" && fields[7] === "host") {
            // Local synthetic fixture for environments whose mDNS host
            // candidates cannot resolve. Only the signalled candidate address
            // is translated to loopback; native RTP/ICE/DTLS/codec APIs remain.
            // No SDP or production source is rewritten by this fixture.
            fields[4] = "127.0.0.1";
            event.candidate.toJSON = () => ({...original, candidate: fields.join(" ")});
          }
        });
      }
    }
    setRemoteDescription(description) {
      if (description?.type === "offer" && this.signalingState === "have-local-offer") state.collisions++;
      return super.setRemoteDescription(description);
    }
  };
  if (mode === "compat") {
    RTCRtpTransceiver.prototype.setCodecPreferences = undefined;
    RTCRtpSender.prototype.setParameters = undefined;
  }
  const nativeCreateElement = document.createElement.bind(document);
  document.createElement = function(tag, ...args) {
    const element = nativeCreateElement(tag, ...args);
    if (tag === "audio") element.muted = true; // No synthetic sound from speakers.
    return element;
  };
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async constraints => {
    state.requests.push(structuredClone(constraints));
    if (mode === "denied-first" && state.requests.length === 1) throw new DOMException("Synthetic permission denial", "NotAllowedError");
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 700));
    const context = new AudioContext();
    state.contexts.push(context);
    await context.resume();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 230 + state.contexts.length * 70;
    const volume = context.createGain();
    volume.gain.value = 0.08;
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    oscillator.connect(volume).connect(destination);
    oscillator.start();
    const track = destination.stream.getAudioTracks()[0];
    state.tracks.push(track);
    const nativeSettings = track.getSettings.bind(track);
    const actual = {};
    const apply = c => {
      for (const key of ["echoCancellation", "noiseSuppression", "autoGainControl", "channelCount"]) {
        if (c?.[key] !== undefined) actual[key] = c[key]?.ideal ?? c[key];
      }
    };
    apply(constraints.audio);
    track.getSettings = () => ({...nativeSettings(), ...actual});
    track.getCapabilities = () => ({echoCancellation: [true, false], noiseSuppression: [true, false], autoGainControl: [true, false]});
    track.applyConstraints = async c => { apply(c); };
    const nativeStop = track.stop.bind(track);
    track.stop = () => { nativeStop(); oscillator.stop(); void context.close(); };
    return destination.stream;
  }});
})();
