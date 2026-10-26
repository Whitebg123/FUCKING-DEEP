(() => {
  "use strict";

  // Capture stays on the original microphone -> RTCRtpSender path. No DSP,
  // AudioContext, resampling, SDP rewriting, or extra playback buffering.
  const DEFAULTS = Object.freeze({
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
    maxBitrate: 64000
  });
  const PROCESSING = ["echoCancellation", "noiseSuppression", "autoGainControl"];
  const LABELS = {echoCancellation: "回声消除", noiseSuppression: "噪声抑制", autoGainControl: "自动增益"};
  const STORAGE_KEY = "boundary-tales-audio-v1";
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const numberOrNull = (value) => finite(value) ? value : null;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function loadPreferences() {
    const result = {...DEFAULTS};
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      for (const key of PROCESSING) {
        if (typeof saved?.[key] === "boolean") result[key] = saved[key];
      }
      if ([0, 32000, 48000, 64000].includes(saved?.maxBitrate)) {
        result.maxBitrate = saved.maxBitrate;
      }
    } catch (_) {
      // Storage may be unavailable or contain an older/corrupt value.
    }
    return result;
  }

  function supportedConstraints() {
    return navigator.mediaDevices?.getSupportedConstraints?.() || {};
  }

  function create({getPeers, notice}) {
    const preferences = loadPreferences();
    const support = supportedConstraints();
    const panel = document.getElementById("audio-settings");
    const captureOutput = document.getElementById("capture-settings");
    const applyStatus = document.getElementById("audio-settings-status");
    const statsOutput = document.getElementById("connection-stats");
    let track = null;
    let captureTask = Promise.resolve();
    let captureError = "";
    let captureApplying = false;
    let timer = null;
    let sampling = null;
    let latest = null;
    let disposed = false;
    let statsGeneration = 0;
    const previousReports = new WeakMap();

    function constraints() {
      const audio = {};
      for (const key of PROCESSING) {
        if (support[key]) audio[key] = {ideal: preferences[key]};
      }
      if (support.channelCount) audio.channelCount = {ideal: 1};
      // Opus uses a 48 kHz RTP clock. That does not require forcing the
      // microphone's hardware sampleRate, sampleSize, or latency.
      return {audio: Object.keys(audio).length ? audio : true, video: false};
    }

    function captureSnapshot() {
      const actual = {};
      const capabilities = {};
      if (track) {
        try {
          const settings = track.getSettings?.() || {};
          for (const key of [...PROCESSING, "sampleRate", "channelCount", "sampleSize", "latency"]) {
            if (settings[key] !== undefined) actual[key] = settings[key];
          }
          const caps = track.getCapabilities?.() || {};
          for (const key of PROCESSING) {
            if (Array.isArray(caps[key])) capabilities[key] = [...caps[key]];
          }
        } catch (_) {
          // Missing browser reporting is shown as unknown, never as success.
        }
      }
      return {
        active: track?.readyState === "live",
        enabled: track?.enabled ?? false,
        requested: {...preferences, channelCount: 1},
        supported: Object.fromEntries([...PROCESSING, "channelCount"].map(key => [key, !!support[key]])),
        actual,
        capabilities,
        applying: captureApplying,
        error: captureError
      };
    }

    function renderCapture() {
      const state = captureSnapshot();
      const lines = [];
      for (const key of PROCESSING) {
        const input = document.getElementById(`audio-${key}`);
        if (input) {
          input.checked = preferences[key];
          const caps = state.capabilities[key];
          input.disabled = !support[key] || (Array.isArray(caps) && !(caps.includes(true) && caps.includes(false)));
        }
        const actual = state.actual[key];
        const result = actual === undefined ? "浏览器未报告" : actual === true ? "开" : actual === false ? "关" : String(actual);
        lines.push(`${LABELS[key]}：请求${preferences[key] ? "开" : "关"} / ${state.active ? `实际${result}` : "尚未采集"}${support[key] ? "" : "（不支持此约束）"}`);
      }
      lines.push(`采集声道：${state.actual.channelCount ?? "未报告"} / 采样率：${state.actual.sampleRate ? `${state.actual.sampleRate} Hz` : "未报告"}`);
      if (captureOutput) captureOutput.textContent = lines.join("\n");
      const mismatch = PROCESSING.some(key => {
        const actual = state.actual[key];
        const enabledEchoMode = key === "echoCancellation" && preferences[key] && ["all", "remote-only"].includes(actual);
        return actual !== undefined && actual !== preferences[key] && !enabledEchoMode;
      });
      if (applyStatus) applyStatus.textContent = captureError || (captureApplying ? "正在应用设置……" : !state.active ? "尚未开启麦克风；将在开启时请求所选偏好。" : mismatch ? "部分请求与实际值不同，以浏览器报告为准；可尝试离开后重新进入。" : "设置已请求。下方仅显示浏览器实际报告的值。未报告不代表已生效。");
    }

    function applyCapture() {
      const activeTrack = track;
      captureTask = captureTask.catch(() => {}).then(async () => {
        if (!activeTrack || activeTrack !== track || activeTrack.readyState !== "live") return;
        captureApplying = true;
        captureError = "";
        renderCapture();
        try {
          if (typeof activeTrack.applyConstraints !== "function") {
            throw new Error("此浏览器不支持通话中调整，请离开后重新进入应用偏好。");
          }
          const audio = constraints().audio;
          await activeTrack.applyConstraints(audio === true ? {} : audio);
        } catch (error) {
          if (activeTrack === track) {
            captureError = `未能调整采集设置（${error.name || "Error"}），保留当前音轨；请离开后重新进入。`;
          }
        } finally {
          if (activeTrack === track) {
            captureApplying = false;
            renderCapture();
          }
        }
      });
      return captureTask;
    }

    function bindTrack(nextTrack) {
      track = nextTrack;
      captureError = "";
      captureApplying = false;
      renderCapture();
      if (track) void applyCapture();
    }

    function preferOpus(peer) {
      try {
        const codecs = window.RTCRtpReceiver?.getCapabilities?.("audio")?.codecs;
        if (!codecs?.some(codec => codec.mimeType.toLowerCase() === "audio/opus")) {
          peer.codecPreference = "浏览器默认（未提供 Opus 能力）";
          return;
        }
        const ordered = [
          ...codecs.filter(codec => codec.mimeType.toLowerCase() === "audio/opus"),
          ...codecs.filter(codec => codec.mimeType.toLowerCase() !== "audio/opus")
        ];
        let applied = false;
        for (const transceiver of peer.pc.getTransceivers()) {
          if (transceiver.receiver.track.kind !== "audio" || transceiver.stopped) continue;
          if (typeof transceiver.setCodecPreferences !== "function") continue;
          // Keep the browser's unmodified codec entries, including fallback,
          // redundancy, comfort noise and telephone-event entries.
          transceiver.setCodecPreferences(ordered);
          applied = true;
        }
        peer.codecPreference = applied ? "Opus 优先（实际编码见统计）" : "浏览器默认（不支持编码偏好 API）";
      } catch (error) {
        peer.codecPreference = `浏览器默认（编码偏好被拒绝：${error.name}）`;
      }
    }

    function configureSenders(peer) {
      // Fresh getParameters() for every queued update. Never manufacture an
      // encodings array or modify negotiated codec/fmtp/transactionId fields.
      peer.audioParameterTask = (peer.audioParameterTask || Promise.resolve()).catch(() => {}).then(async () => {
        if (peer.pc.connectionState === "closed") return;
        peer.senderConfiguration = [];
        for (const sender of peer.pc.getSenders()) {
          if (sender.track?.kind !== "audio") continue;
          const requested = preferences.maxBitrate;
          const result = {requestedMaxBitrate: requested || null, observedMaxBitrate: null, status: "pending"};
          peer.senderConfiguration.push(result);
          try {
            if (typeof sender.getParameters !== "function" || typeof sender.setParameters !== "function") {
              result.status = "unsupported";
              continue;
            }
            const parameters = sender.getParameters();
            if (!parameters.encodings?.length) continue; // Retry after negotiation.
            for (const encoding of parameters.encodings) {
              if (requested) encoding.maxBitrate = requested;
              else delete encoding.maxBitrate;
            }
            await sender.setParameters(parameters);
            const actual = sender.getParameters().encodings || [];
            result.observedMaxBitrate = actual.map(encoding => numberOrNull(encoding.maxBitrate));
            result.status = actual.length && actual.every(encoding => requested ? encoding.maxBitrate === requested : encoding.maxBitrate === undefined) ? "verified" : "unconfirmed";
          } catch (error) {
            result.status = "rejected";
            result.error = error.name || "Error";
          }
        }
      });
      return peer.audioParameterTask;
    }

    function saveAndApply() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
      renderCapture();
      void applyCapture();
      for (const peer of getPeers()) void configureSenders(peer);
    }

    function delta(current, old, key) {
      if (!finite(current?.[key]) || !finite(old?.[key])) return null;
      const value = current[key] - old[key];
      return value >= 0 ? value : null;
    }

    function bitrate(current, old, key) {
      const bytes = delta(current, old, key);
      const ms = finite(current?.timestamp) && finite(old?.timestamp) ? current.timestamp - old.timestamp : 0;
      return bytes !== null && ms > 0 ? bytes * 8 / ms : null;
    }

    function codecInfo(report, id) {
      const codec = report.get(id);
      if (!codec) return null;
      return {mimeType: codec.mimeType, clockRate: codec.clockRate, channels: codec.channels, sdpFmtpLine: codec.sdpFmtpLine || ""};
    }

    async function samplePeer(peer, index) {
      const pc = peer.pc;
      const result = {
        peer: index + 1,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        codecPreference: peer.codecPreference || "尚未协商",
        senders: copy(peer.senderConfiguration || []),
        outbound: [], inbound: [], network: null
      };
      try {
        const report = await pc.getStats();
        const stats = [...report.values()];
        const previous = previousReports.get(peer) || new Map();
        const next = new Map();
        const transport = stats.find(stat => stat.type === "transport" && stat.selectedCandidatePairId);
        const pair = transport ? report.get(transport.selectedCandidatePairId) : stats.find(stat => stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded");
        if (pair) {
          const local = report.get(pair.localCandidateId);
          const remote = report.get(pair.remoteCandidateId);
          result.network = {
            iceRttMs: finite(pair.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null,
            availableOutgoingKbps: finite(pair.availableOutgoingBitrate) ? pair.availableOutgoingBitrate / 1000 : null,
            localCandidateType: local?.candidateType || null,
            remoteCandidateType: remote?.candidateType || null,
            protocol: local?.protocol || null
          };
        }
        for (const stat of stats) {
          if ((stat.kind || stat.mediaType) !== "audio") continue;
          const old = previous.get(stat.id);
          if (stat.type === "outbound-rtp") {
            const remote = report.get(stat.remoteId) || stats.find(item => item.type === "remote-inbound-rtp" && item.localId === stat.id);
            result.outbound.push({
              codec: codecInfo(report, stat.codecId),
              kbps: bitrate(stat, old, "bytesSent"),
              bytesSent: numberOrNull(stat.bytesSent),
              packetsSent: numberOrNull(stat.packetsSent),
              targetKbps: finite(stat.targetBitrate) ? stat.targetBitrate / 1000 : null,
              remoteLossPercent: finite(remote?.fractionLost) ? Math.max(0, Math.min(100, remote.fractionLost * 100)) : null,
              remoteJitterMs: finite(remote?.jitter) ? remote.jitter * 1000 : null,
              rtcpRttMs: finite(remote?.roundTripTime) ? remote.roundTripTime * 1000 : null,
              remoteReportAgeMs: remote && finite(remote.timestamp) ? Math.max(0, stat.timestamp - remote.timestamp) : null
            });
          } else if (stat.type === "inbound-rtp") {
            const received = delta(stat, old, "packetsReceived");
            // Late packets can make packetsLost decrease. Preserve that as an
            // unknown interval rather than inventing a negative/zero loss rate.
            const lost = delta(stat, old, "packetsLost");
            const samples = delta(stat, old, "totalSamplesReceived");
            const concealed = delta(stat, old, "concealedSamples");
            const emitted = delta(stat, old, "jitterBufferEmittedCount");
            const bufferDelay = delta(stat, old, "jitterBufferDelay");
            result.inbound.push({
              codec: codecInfo(report, stat.codecId),
              kbps: bitrate(stat, old, "bytesReceived"),
              bytesReceived: numberOrNull(stat.bytesReceived),
              packetsReceived: numberOrNull(stat.packetsReceived),
              packetsLost: numberOrNull(stat.packetsLost),
              intervalLossPercent: received !== null && lost !== null && received + lost > 0 ? lost * 100 / (received + lost) : null,
              jitterMs: finite(stat.jitter) ? stat.jitter * 1000 : null,
              jitterBufferMs: bufferDelay !== null && emitted > 0 ? bufferDelay * 1000 / emitted : null,
              concealedPercent: concealed !== null && samples > 0 ? concealed * 100 / samples : null,
              audioLevel: numberOrNull(stat.audioLevel)
            });
          }
          if (stat.type === "outbound-rtp" || stat.type === "inbound-rtp") next.set(stat.id, {...stat});
        }
        previousReports.set(peer, next);
      } catch (error) {
        result.error = error.name || "统计不可用";
      }
      return result;
    }

    function format(value, suffix = "") {
      return finite(value) ? `${value.toFixed(1)}${suffix}` : "未报告／待采样";
    }

    function renderStats(snapshot) {
      if (!statsOutput) return;
      if (!snapshot.peers.length) {
        statsOutput.textContent = "尚无伙伴连接。加入房间并至少连接一位伙伴后显示统计。";
        return;
      }
      statsOutput.replaceChildren();
      for (const peer of snapshot.peers) {
        const card = document.createElement("div");
        card.className = "quality-peer";
        const title = document.createElement("strong");
        title.textContent = `伙伴 ${peer.peer} · ${peer.connectionState}`;
        const body = document.createElement("pre");
        const lines = [];
        for (const out of peer.outbound) {
          lines.push(`发送：${out.codec?.mimeType || "未报告"} / RTP 时钟 ${out.codec?.clockRate || "未知"} Hz / ${format(out.kbps, " kbps")}`);
          lines.push(`对端报告丢包 ${format(out.remoteLossPercent, "%")} · 抖动 ${format(out.remoteJitterMs, " ms")} · RTCP RTT ${format(out.rtcpRttMs, " ms")}`);
          lines.push(`Opus fmtp：${out.codec?.sdpFmtpLine || "浏览器默认／未报告"}`);
          if (out.remoteReportAgeMs !== null) lines.push(`对端报告距当前采样 ${format(out.remoteReportAgeMs / 1000, " s")}`);
        }
        for (const incoming of peer.inbound) {
          lines.push(`接收：${incoming.codec?.mimeType || "未报告"} / ${format(incoming.kbps, " kbps")} · 本采样间隔丢包 ${format(incoming.intervalLossPercent, "%")}`);
          lines.push(`接收抖动 ${format(incoming.jitterMs, " ms")} · 缓冲 ${format(incoming.jitterBufferMs, " ms")} · 补偿样本 ${format(incoming.concealedPercent, "%")}`);
        }
        for (const sender of peer.senders) {
          const requested = sender.requestedMaxBitrate ? `${sender.requestedMaxBitrate / 1000} kbps` : "浏览器自动";
          const states = {verified: "参数回读一致", pending: "等待协商", unsupported: "API 不支持", rejected: "浏览器拒绝", unconfirmed: "回读未确认"};
          lines.push(`发送上限请求 ${requested} · ${states[sender.status] || sender.status}${sender.error ? `（${sender.error}）` : ""}`);
        }
        if (peer.network) lines.push(`ICE RTT ${format(peer.network.iceRttMs, " ms")} · ${peer.network.localCandidateType} ↔ ${peer.network.remoteCandidateType} / ${peer.network.protocol}`);
        if (peer.error) lines.push(`统计暂不可用：${peer.error}`);
        body.textContent = lines.join("\n") || "正在协商，等待媒体统计……";
        card.append(title, body);
        statsOutput.appendChild(card);
      }
    }

    function snapshot() {
      if (sampling) return sampling;
      sampling = (async () => {
        const peers = await Promise.all(getPeers().map(samplePeer));
        // Only whitelisted settings/stats are exported: no password, device
        // identifiers, socket IDs, IP addresses, SDP, or audio recordings.
        latest = {version: 1, sampledAt: new Date().toISOString(), capture: captureSnapshot(), peers};
        if (!disposed) renderStats(latest);
        return copy(latest);
      })().finally(() => { sampling = null; });
      return sampling;
    }

    function scheduleStats() {
      const generation = ++statsGeneration;
      clearTimeout(timer);
      timer = null;
      if (disposed || !panel?.open || document.hidden) return;
      void snapshot().finally(() => {
        if (!disposed && generation === statsGeneration && panel.open && !document.hidden) timer = setTimeout(scheduleStats, 2000);
      });
    }

    for (const key of PROCESSING) {
      document.getElementById(`audio-${key}`)?.addEventListener("change", event => {
        preferences[key] = event.target.checked;
        saveAndApply();
      });
    }
    const bitrateSelect = document.getElementById("audio-bitrate");
    if (bitrateSelect) {
      bitrateSelect.value = String(preferences.maxBitrate);
      bitrateSelect.addEventListener("change", () => {
        preferences.maxBitrate = Number(bitrateSelect.value);
        saveAndApply();
      });
    }
    document.getElementById("audio-recommended")?.addEventListener("click", () => {
      for (const key of PROCESSING) preferences[key] = DEFAULTS[key];
      saveAndApply();
    });
    document.getElementById("audio-original")?.addEventListener("click", () => {
      for (const key of PROCESSING) preferences[key] = true;
      saveAndApply();
    });
    panel?.addEventListener("toggle", scheduleStats);
    document.addEventListener("visibilitychange", scheduleStats);
    document.getElementById("audio-export")?.addEventListener("click", async () => {
      const report = await snapshot();
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
      const link = document.createElement("a");
      link.href = url;
      link.download = "voice-diagnostics.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notice?.("诊断已导出，不包含口令、设备标识、IP 或录音。", "success");
    });

    window.voiceDiagnostics = Object.freeze({
      snapshot,
      getLatest: () => latest ? copy(latest) : null,
      capture: () => copy(captureSnapshot())
    });
    renderCapture();
    return {constraints, bindTrack, preferOpus, configureSenders, refreshCapture: renderCapture,
      dispose() { disposed = true; clearTimeout(timer); track = null; }
    };
  }

  window.VoiceAudio = Object.freeze({create});
})();
