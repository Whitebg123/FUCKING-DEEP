"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/audio-quality.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(options = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      checked: false, disabled: false, value: "", textContent: "", open: false,
      listeners: {}, children: [], className: "",
      addEventListener(type, fn) { this.listeners[type] = fn; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      click() { this.listeners.click?.({target: this}); }
    });
    return elements.get(id);
  };
  const storage = new Map(options.saved === undefined ? [] : [["boundary-tales-audio-v1", options.saved]]);
  const peers = [];
  const window = {RTCRtpReceiver: options.receiver};
  const document = {
    hidden: false,
    getElementById: element,
    createElement: tag => element(`${tag}-${Math.random()}`),
    addEventListener() {}
  };
  const support = options.support ?? {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: true};
  vm.runInNewContext(source, {
    window, document, navigator: {mediaDevices: {getSupportedConstraints: () => support}},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    console, setTimeout, clearTimeout, URL, Blob
  });
  const quality = window.VoiceAudio.create({getPeers: () => peers});
  return {window, document, quality, peers, element, storage};
}

test("compatible capture defaults and storage validation; no mandatory sample rate", () => {
  const env = setup({saved: '{"noiseSuppression":"false","maxBitrate":99999999}'});
  assert.deepEqual(plain(env.quality.constraints()), {audio: {
    echoCancellation: {ideal: true}, noiseSuppression: {ideal: false}, autoGainControl: {ideal: false}, channelCount: {ideal: 1}
  }, video: false});
  assert.equal(env.window.voiceDiagnostics.capture().requested.maxBitrate, 64000);
  const unsupported = setup({support: {}, saved: "broken json"});
  assert.deepEqual(plain(unsupported.quality.constraints()), {audio: true, video: false});
  assert.equal(unsupported.element("audio-noiseSuppression").disabled, true);
});

test("actual capture values, unsupported settings and rejected live changes stay explicit", async () => {
  const env = setup();
  const track = {readyState: "live", enabled: true,
    getSettings: () => ({echoCancellation: true, noiseSuppression: true, sampleRate: 44100, channelCount: 2, deviceId: "private-device"}),
    getCapabilities: () => ({echoCancellation: [true, false], noiseSuppression: [true], deviceId: "secret"}),
    applyConstraints: async () => { throw new DOMException("not supported", "OverconstrainedError"); }
  };
  env.quality.bindTrack(track);
  await tick();
  const state = env.window.voiceDiagnostics.capture();
  assert.equal(state.actual.noiseSuppression, true);
  assert.equal(state.requested.noiseSuppression, false);
  assert.equal(state.actual.autoGainControl, undefined);
  assert.equal(state.actual.sampleRate, 44100);
  assert.match(state.error, /OverconstrainedError/);
  assert.equal(env.element("audio-noiseSuppression").disabled, true);
  assert.doesNotMatch(JSON.stringify(state), /private-device|secret|deviceId/);
  env.quality.bindTrack(null);
  assert.equal(env.window.voiceDiagnostics.capture().active, false);
});

test("rapid processing toggles serialize changes and preserve a muted track", async () => {
  const env = setup();
  let running = 0, maxRunning = 0, calls = 0;
  let actual = {};
  const track = {readyState: "live", enabled: false,
    getSettings: () => actual,
    async applyConstraints(c) {
      running++; maxRunning = Math.max(maxRunning, running); calls++;
      await tick();
      actual = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.ideal]));
      running--;
    }
  };
  env.quality.bindTrack(track);
  const control = env.element("audio-autoGainControl");
  control.checked = true; control.listeners.change({target: control});
  control.checked = false; control.listeners.change({target: control});
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(maxRunning, 1);
  assert.equal(calls, 3);
  assert.equal(actual.autoGainControl, false);
  assert.equal(track.enabled, false);
  assert.equal(JSON.parse(env.storage.get("boundary-tales-audio-v1")).autoGainControl, false);
});

test("supported named echo modes satisfy an enabled echo-cancellation preference", async () => {
  const env = setup();
  env.quality.bindTrack({readyState: "live", enabled: true,
    getSettings: () => ({echoCancellation: "remote-only", noiseSuppression: false, autoGainControl: false}),
    applyConstraints: async () => {}
  });
  await tick();
  assert.doesNotMatch(env.element("audio-settings-status").textContent, /不同/);
  assert.match(env.element("capture-settings").textContent, /remote-only/);
});

test("Opus ordering preserves unmodified fallback and FEC codec capabilities", () => {
  const codecs = [{mimeType: "audio/PCMU", clockRate: 8000}, {mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "useinbandfec=1"}, {mimeType: "audio/red", clockRate: 48000}];
  const env = setup({receiver: {getCapabilities: () => ({codecs})}});
  let chosen;
  const peer = {pc: {getTransceivers: () => [{receiver: {track: {kind: "audio"}}, setCodecPreferences: value => { chosen = value; }}]}};
  env.quality.preferOpus(peer);
  assert.equal(chosen[0], codecs[1]);
  assert.equal(chosen[1], codecs[0]);
  assert.equal(chosen[2], codecs[2]);
  assert.equal(codecs[1].channels, 2);
  assert.match(peer.codecPreference, /Opus/);
  const unsupported = {pc: {getTransceivers: () => [{receiver: {track: {kind: "audio"}}}]}};
  env.quality.preferOpus(unsupported);
  assert.match(unsupported.codecPreference, /不支持/);
});

test("sender cap uses fresh parameters, serializes updates and can remove the application cap", async () => {
  const env = setup();
  let actual = {encodings: []}, transaction = 0, pending = false;
  const sender = {track: {kind: "audio"},
    getParameters() { return {...structuredClone(actual), transactionId: String(++transaction)}; },
    async setParameters(value) {
      assert.equal(pending, false); pending = true;
      assert.ok(value.transactionId);
      await tick(); actual = structuredClone(value); pending = false;
    }
  };
  const peer = {pc: {connectionState: "new", getSenders: () => [sender]}};
  env.peers.push(peer);
  await env.quality.configureSenders(peer);
  assert.equal(peer.senderConfiguration[0].status, "pending");
  actual.encodings = [{active: true}];
  await Promise.all([env.quality.configureSenders(peer), env.quality.configureSenders(peer)]);
  assert.equal(actual.encodings[0].maxBitrate, 64000);
  assert.equal(peer.senderConfiguration[0].status, "verified");
  const select = env.element("audio-bitrate");
  select.value = "0"; select.listeners.change();
  await peer.audioParameterTask;
  assert.equal(actual.encodings[0].maxBitrate, undefined);
  assert.equal(peer.senderConfiguration[0].status, "verified");
  sender.setParameters = async () => { throw new DOMException("no", "NotSupportedError"); };
  await env.quality.configureSenders(peer);
  assert.equal(peer.senderConfiguration[0].status, "rejected");
});

test("statistics use interval bytes/loss, preserve missing values, follow remoteId and omit private fields", async () => {
  const env = setup();
  let time = 1000, bytes = 1000, received = 50, lost = 1;
  const pc = {connectionState: "connected", iceConnectionState: "connected", signalingState: "stable",
    async getStats() { return new Map([
      ["codec", {id: "codec", type: "codec", mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "useinbandfec=1"}],
      ["out", {id: "out", type: "outbound-rtp", kind: "audio", codecId: "codec", remoteId: "remote", timestamp: time, bytesSent: bytes, packetsSent: received}],
      ["remote", {id: "remote", type: "remote-inbound-rtp", localId: "out", timestamp: time - 50, fractionLost: 0.02, roundTripTime: 0.04}],
      ["in", {id: "in", type: "inbound-rtp", kind: "audio", codecId: "codec", timestamp: time, bytesReceived: bytes, packetsReceived: received, packetsLost: lost, jitter: 0.003, totalSamplesReceived: received * 960, concealedSamples: lost * 960, jitterBufferDelay: received * 0.02, jitterBufferEmittedCount: received}],
      ["transport", {id: "transport", type: "transport", selectedCandidatePairId: "pair"}],
      ["pair", {id: "pair", type: "candidate-pair", currentRoundTripTime: 0.05, localCandidateId: "local", remoteCandidateId: "remote-ice"}],
      ["local", {id: "local", type: "local-candidate", address: "private-ip", candidateType: "host", protocol: "udp"}],
      ["remote-ice", {id: "remote-ice", type: "remote-candidate", candidateType: "srflx"}]
    ]); }
  };
  env.peers.push({pc});
  const first = await env.window.voiceDiagnostics.snapshot();
  assert.equal(first.peers[0].outbound[0].kbps, null);
  assert.equal(first.peers[0].inbound[0].intervalLossPercent, null);
  time += 2000; bytes += 16000; received += 99; lost += 1;
  const second = await env.window.voiceDiagnostics.snapshot();
  assert.equal(second.peers[0].outbound[0].kbps, 64);
  assert.equal(second.peers[0].outbound[0].rtcpRttMs, 40);
  assert.equal(second.peers[0].outbound[0].remoteLossPercent, 2);
  assert.equal(second.peers[0].outbound[0].remoteJitterMs, null);
  assert.equal(second.peers[0].inbound[0].intervalLossPercent, 1);
  assert.equal(second.peers[0].network.iceRttMs, 50);
  assert.doesNotMatch(JSON.stringify(second), /private-ip|address|deviceId|password|socket/);
  time += 2000; bytes += 1000; received += 20; lost -= 1;
  const third = await env.window.voiceDiagnostics.snapshot();
  assert.equal(third.peers[0].inbound[0].intervalLossPercent, null);
  const exported = env.window.voiceDiagnostics.getLatest();
  exported.peers.length = 0;
  assert.equal(env.window.voiceDiagnostics.getLatest().peers.length, 1);
});
