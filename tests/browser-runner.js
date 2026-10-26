"use strict";
const $ = id => document.getElementById(id);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const frames = [];
const archived = [];
let clientNumber = 0;
const report = {status: "running", steps: [], measurements: [], limitation: "One Chrome instance, loopback network, synthetic capture. No physical microphone processing, acoustic quality, real WAN or five-device CPU/latency claim."};
const element = (frame, id) => frame.contentDocument.getElementById(id);
const media = frame => frame.contentWindow.testMedia;
const diagnostic = frame => frame.contentWindow.voiceDiagnostics;
const latest = frame => diagnostic(frame).getLatest();
async function until(check, message, timeout = 18000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await pause(80); }
  throw new Error(message);
}
function pass(message) {
  report.steps.push(message);
  const item = document.createElement("li"); item.className = "pass"; item.textContent = `PASS: ${message}`; $("results").append(item);
  $("status").textContent = message;
}
async function client(mode = "normal") {
  const frame = document.createElement("iframe");
  frame.title = `Test client ${++clientNumber}`;
  frame.allow = "autoplay";
  frame.src = `/test/client?mode=${mode}&client=${clientNumber}&loopback=${$("loopback").checked ? 1 : 0}`;
  $("frames").append(frame); frames.push(frame);
  await until(() => diagnostic(frame), "Client scripts did not initialize", 30000);
  return frame;
}
function login(frame, password = "local-synthetic-test-only") {
  element(frame, "password-input").value = password;
  element(frame, "login-form").requestSubmit();
}
function click(frame, id) { element(frame, id).click(); }
function archive(frame) {
  archived.push({url: frame.src, errors: [...media(frame).errors], captures: media(frame).requests.length,
    allTracksEnded: media(frame).tracks.every(track => track.readyState === "ended"),
    allConnectionsClosed: media(frame).connections.every(pc => pc.connectionState === "closed")});
  frames.splice(frames.indexOf(frame), 1);
  frame.remove();
}
function select(frame, value) {
  const control = element(frame, "audio-bitrate"); control.value = String(value);
  control.dispatchEvent(new frame.contentWindow.Event("change", {bubbles: true}));
}
async function samples(active) { return Promise.all(active.map(frame => diagnostic(frame).snapshot())); }
async function mesh(active) {
  await until(async () => {
    const data = await samples(active);
    return data.every(item => item.peers.length === active.length - 1 && item.peers.every(peer => peer.connectionState === "connected" && peer.signalingState === "stable"));
  }, `Expected ${active.length}-party connected mesh`);
}
async function leave(frame) {
  click(frame, "leave-button");
  await until(() => !element(frame, "login-screen").hidden, "Leave did not return to login");
  assert(media(frame).tracks.every(track => track.readyState === "ended"), "A microphone track leaked after leaving");
  assert(media(frame).connections.every(pc => pc.connectionState === "closed"), "Peer connection leaked after leaving");
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  report.loopbackCandidateFixture = $("loopback").checked;
  try {
    for (const endpoint of ["/health", "/", "/style.css", "/app.js", "/audio-quality.js", "/socket.io/socket.io.js"]) {
      assert((await fetch(endpoint)).ok, `${endpoint} failed`);
    }
    pass("Health, original page, styles and all scripts respond successfully");
    const first = await client("denied-first");
    login(first, "incorrect-test-only");
    await until(() => element(first, "login-error").textContent.includes("口令错误"), "Wrong password was not rejected");
    assert(media(first).requests.length === 0, "Microphone requested before authentication");
    pass("Wrong password rejected without opening microphone");
    login(first);
    await until(() => !element(first, "room-screen").hidden && media(first).requests.length === 1, "Receive-only client did not join");
    const active = [first];
    for (let i = 0; i < 4; i++) {
      const frame = await client(); login(frame); active.push(frame);
      await until(() => !element(frame, "room-screen").hidden && media(frame).tracks.length, "Participant could not join");
    }
    await mesh(active);
    assert(media(first).tracks.length === 0, "Denied microphone unexpectedly opened");
    pass("Five participants connect with four peer connections each, including one receive-only member");
    const sixth = await client(); login(sixth);
    await until(() => element(sixth, "login-error").textContent.includes("房间已满"), "Sixth participant was not rejected");
    assert(media(sixth).requests.length === 0, "Full-room rejection leaked microphone access");
    pass("Sixth participant rejected; original five-person capacity retained");
    archive(sixth);
    click(first, "mute-button");
    await until(() => diagnostic(first).capture().active, "Microphone retry failed");
    await mesh(active);
    await samples(active); await pause(2300);
    const five = await samples(active);
    assert(five.every(item => item.peers.every(peer => peer.outbound.some(stream => stream.codec?.mimeType === "audio/opus" && stream.codec.clockRate === 48000 && stream.kbps > 0) && peer.inbound.some(stream => stream.bytesReceived > 0))), "Not all 20 audio directions carry Opus RTP");
    assert(five.every(item => item.peers.every(peer => peer.senders.length && peer.senders.every(sender => sender.status === "verified" && sender.observedMaxBitrate.every(value => value === 64000)))), "64 kbps parameter cap was not confirmed on all senders");
    report.measurements.push({case: "five-party-full-duplex", snapshots: five});
    pass("Permission retry adds microphone to existing peers; all 20 directions carry Opus/48000 with 64 kbps caps read back");
    const track = media(first).tracks.at(-1);
    click(first, "mute-button"); assert(!track.enabled, "Mute did not disable original track");
    click(first, "audio-original");
    await until(() => diagnostic(first).capture().actual.autoGainControl === true, "Processing switches did not update");
    assert(!track.enabled, "Changing processing accidentally unmuted microphone");
    click(first, "audio-echoCancellation");
    await until(() => diagnostic(first).capture().actual.echoCancellation === false, "Echo switch did not update");
    click(first, "audio-recommended");
    await until(() => diagnostic(first).capture().actual.echoCancellation === true && diagnostic(first).capture().actual.noiseSuppression === false && diagnostic(first).capture().actual.autoGainControl === false, "Recommended profile failed");
    click(first, "mute-button"); assert(track.enabled, "Unmute failed");
    assert(media(first).tracks.length === 1, "Processing switches acquired extra microphone streams");
    select(first, 48000);
    await until(async () => (await diagnostic(first).snapshot()).peers.every(peer => peer.senders.every(sender => sender.observedMaxBitrate?.every(value => value === 48000))), "48 kbps live cap failed");
    select(first, 0);
    await until(async () => (await diagnostic(first).snapshot()).peers.every(peer => peer.senders.every(sender => sender.status === "verified" && sender.observedMaxBitrate?.every(value => value === null))), "Removing application cap failed");
    await mesh(active);
    pass("All processing switches and 48 kbps/automatic modes update during calls; mute and original audio track preserved");
    const last = active.at(-1); await leave(last); active.pop(); await mesh(active);
    assert(active.every(frame => element(frame, "member-count").textContent === "4"), "Room count not updated after leave");
    login(last); active.push(last); await mesh(active);
    pass("Leave closes audio/peer resources; rejoining restores the five-person mesh and room count");
    first.contentWindow.testSocket.io.engine.close();
    await until(() => !element(first, "login-screen").hidden, "Transport loss did not return to login");
    assert(media(first).tracks.every(item => item.readyState === "ended"), "Track leaked after disconnect");
    login(first); await mesh(active);
    pass("Signalling transport loss cleans up; manual login reconnects all four peers");
    await leave(last); active.pop();
    archive(last);
    const compat = await client("compat"); login(compat); active.push(compat); await mesh(active);
    await until(async () => (await diagnostic(compat).snapshot()).peers.every(peer => peer.senders.length && peer.senders.every(sender => sender.status === "unsupported")), "Unsupported sender API was not reported");
    pass("Without codec-preference/setParameters APIs, default browser negotiation still connects and reports unsupported cap");
    await leave(compat); active.pop();
    archive(compat);
    const slow = await client("slow"); login(slow);
    await until(() => media(slow).requests.length === 1, "Delayed capture did not start");
    click(slow, "leave-button");
    await until(() => media(slow).tracks.length && media(slow).tracks.every(item => item.readyState === "ended"), "Late microphone result leaked after leaving");
    assert(!diagnostic(slow).capture().active, "Late capture replaced current room state");
    await mesh(active);
    pass("Leaving during pending microphone acquisition stops the late stream and preserves other members");
    archive(slow);
    for (const frame of active) { await leave(frame); archive(frame); }
    const a = await client("denied-first"), b = await client("denied-first");
    login(a); login(b);
    await until(() => media(a).requests.length === 1 && media(b).requests.length === 1 && media(a).connections.length && media(b).connections.length, "Receive-only peers not ready");
    click(a, "mute-button"); click(b, "mute-button");
    await mesh([a, b]);
    await samples([a,b]); await pause(1200);
    const simultaneous = await samples([a,b]);
    assert(simultaneous.every(item => item.peers[0].outbound.some(stream => stream.bytesSent > 0)), "Simultaneous microphone retry failed");
    report.simultaneousOfferCollisionsObserved = media(a).collisions + media(b).collisions;
    pass("Two receive-only peers enable microphones simultaneously and renegotiate successfully");
    for (const frame of [a,b]) await leave(frame);
    assert(frames.every(frame => media(frame).errors.length === 0) && archived.every(item => item.errors.length === 0), `Browser errors: ${frames.flatMap(frame => media(frame).errors).join("; ")}`);
    pass("No uncaught browser errors or unhandled rejections; all synthetic tracks released");
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = error.stack || String(error);
    const item = document.createElement("li"); item.className = "fail"; item.textContent = `FAIL: ${error.message}`; $("results").append(item);
  } finally {
    report.clients = frames.map(frame => ({
      url: frame.src,
      ready: frame.contentDocument?.readyState,
      title: frame.contentDocument?.title,
      errors: media(frame)?.errors,
      captures: media(frame)?.requests.length,
      states: media(frame)?.connections.map(pc => ({connection: pc.connectionState, signaling: pc.signalingState})),
      candidateCounts: media(frame)?.connections.map(pc => ({
        local: (pc.localDescription?.sdp.match(/^a=candidate:/gm) || []).length,
        remote: (pc.remoteDescription?.sdp.match(/^a=candidate:/gm) || []).length,
        gathering: pc.iceGatheringState,
        ice: pc.iceConnectionState,
        localProfile: (pc.localDescription?.sdp.match(/^a=candidate:.*$/gm) || []).map(line => {
          const fields = line.split(/\s+/);
          return {protocol: fields[2], type: fields[7], mdns: fields[4]?.endsWith(".local")};
        })
      })),
      socketConnected: frame.contentWindow.testSocket?.connected
    }));
    report.archivedClients = archived;
    for (const frame of frames) {
      if (frame.contentWindow.testSocket?.connected) click(frame, "leave-button");
    }
    report.browser = navigator.userAgent;
    report.completedAt = new Date().toISOString();
    $("status").textContent = report.status.toUpperCase();
    $("details").textContent = JSON.stringify({...report, measurements: `${report.measurements.length} detailed native WebRTC snapshots saved at /test/report`}, null, 2);
    await fetch("/test/report", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(report)});
  }
});
