
(() => {
  "use strict";

  // ==========================================
  // 疆界时物语 · BOUNDARY TALES
  // WebRTC 多人语音客户端
  // ==========================================

  const $ = (id) => document.getElementById(id);

  const loginScreen = $("login-screen");
  const roomScreen = $("room-screen");
  const loginForm = $("login-form");
  const passwordInput = $("password-input");
  const loginButton = $("login-button");
  const loginButtonLabel = loginButton.querySelector("span");
  const loginError = $("login-error");

  const connectionBadge = $("connection-badge");
  const connectionText = $("connection-text");

  const roomStatus = $("room-status");
  const roomSubtitle = $("room-subtitle");
  const memberCount = $("member-count");
  const peerList = $("peer-list");
  const audioContainer = $("audio-container");

  const muteButton = $("mute-button");
  const muteLabel = $("mute-label");
  const leaveButton = $("leave-button");

  const togglePasswordButton = $("toggle-password");
  const wallpaperInput = $("wallpaper-input");
  const toastContainer = $("toast-container");

  // 当前连接状态
  let socket = null;
  let localStream = null;
  let isMuted = true;
  let mediaReady = false;

  // 当前房间成员
  let knownPeerIds = new Set();
  const peers = new Map();

  // 等待麦克风准备好后处理的事件
  let pendingRoomUsers = [];
  const pendingPeerJoins = new Set();
  let pendingSignals = [];

  let lastPassword = "";
  let joiningRejected = false;
  let roomErrorMessage = "";

  let wallpaperObjectUrl = null;
  let audioPlaybackWarningShown = false;

  // STUN 服务器帮助不同网络中的设备建立 P2P 连接。
  // 暂未配置 TURN 中继，部分网络可能无法直接连接。
  const rtcConfiguration = {
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      },
      {
        urls: "stun:stun.cloudflare.com:3478"
      }
    ]
  };

  // ---------- 页面状态 ----------

  function setConnectionStatus(text, state = "") {
    connectionText.textContent = text;

    connectionBadge.classList.remove(
      "connected",
      "error"
    );

    if (state) {
      connectionBadge.classList.add(state);
    }
  }

  function setLoginError(message = "") {
    loginError.textContent = message;
  }

  function setLoginButtonState(loading, text) {
    loginButton.disabled = loading;
    loginButtonLabel.textContent = text;
  }

  function setRoomStatus(text, active = false) {
    roomStatus.textContent = text;

    const indicator = document.querySelector(
      ".live-indicator"
    );

    if (indicator) {
      indicator.classList.toggle("active", active);
    }
  }

  function updateOverallRoomStatus() {
    const connectedCount = [...peers.values()].filter(
      (peer) => peer.pc.connectionState === "connected"
    ).length;

    if (knownPeerIds.size === 0) {
      setRoomStatus("等待伙伴加入", false);
    } else if (connectedCount > 0) {
      setRoomStatus(
        `已连接 ${connectedCount} 位伙伴`,
        true
      );
    } else {
      setRoomStatus("正在建立语音连接……", false);
    }
  }

  function updateRoomCount(count) {
    if (!Number.isFinite(count)) {
      return;
    }

    memberCount.textContent = String(count);

    if (count <= 1) {
      roomSubtitle.textContent =
        "房间已经准备好，等待伙伴加入。";
    } else {
      roomSubtitle.textContent =
        `${count} 位旅人已在同一片星空下。`;
    }
  }

  function showToast(message, type = "") {
    const toast = document.createElement("div");

    toast.className = `toast ${type}`.trim();
    toast.textContent = message;

    toastContainer.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 3800);
  }

  // ---------- 麦克风 ----------

  function updateMuteButton() {
    if (!localStream) {
      muteLabel.textContent = "开启麦克风";
      muteButton.classList.add("muted");
      muteButton.title = "点击请求麦克风权限";
    } else if (isMuted) {
      muteLabel.textContent = "开启麦克风";
      muteButton.classList.add("muted");
      muteButton.title = "当前麦克风已关闭";
    } else {
      muteLabel.textContent = "关闭麦克风";
      muteButton.classList.remove("muted");
      muteButton.title = "点击关闭麦克风";
    }
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    localStream = null;
    isMuted = true;

    updateMuteButton();
  }

  async function startRoomMedia(activeSocket) {
    setRoomStatus("正在请求麦克风权限……", false);

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

      // 如果用户已经离开房间，不再保留麦克风。
      if (
        socket !== activeSocket ||
        !activeSocket.connected ||
        roomScreen.hidden
      ) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });

        return;
      }

      localStream = stream;
      isMuted = false;

      setRoomStatus(
        "麦克风已就绪，正在连接伙伴……",
        false
      );
    } catch (error) {
      if (
        socket !== activeSocket ||
        !activeSocket.connected ||
        roomScreen.hidden
      ) {
        return;
      }

      localStream = null;
      isMuted = true;

      setRoomStatus(
        "已进入房间，当前为仅接收模式",
        false
      );

      showToast(
        "未能开启麦克风，可以检查浏览器权限后重试。",
        "error"
      );
    }

    mediaReady = true;

    updateMuteButton();
    renderPeerList();

    await flushPendingEvents();
  }

  // 首次麦克风权限被拒绝时，可以点击按钮重新申请。
  // 成功后通过 WebRTC 重新协商，把麦克风加入现有连接。
  async function requestMicrophoneInRoom() {
    const activeSocket = socket;

    if (
      !activeSocket ||
      !activeSocket.connected ||
      roomScreen.hidden
    ) {
      showToast("请先进入语音房间。", "error");
      return;
    }

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

      if (
        socket !== activeSocket ||
        !activeSocket.connected ||
        roomScreen.hidden
      ) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });

        return;
      }

      localStream = stream;
      isMuted = false;

      const audioTrack = stream.getAudioTracks()[0];

      if (!audioTrack) {
        stopLocalStream();

        showToast(
          "没有找到可用的麦克风音轨。",
          "error"
        );

        return;
      }

      // 为已经建立的连接添加本地音轨。
      for (const [peerId, peer] of peers) {
        try {
          const transceiver =
            peer.pc.getTransceivers().find(
              (item) =>
                item.receiver &&
                item.receiver.track.kind === "audio"
            );

          if (transceiver) {
            await transceiver.sender.replaceTrack(
              audioTrack
            );

            transceiver.direction = "sendrecv";
          } else {
            peer.pc.addTrack(audioTrack, stream);
          }

          peer.needsOffer = true;

          void createOffer(peerId, peer);
        } catch (error) {
          console.error(
            "添加麦克风音轨失败：",
            error
          );
        }
      }

      updateMuteButton();
      renderPeerList();

      showToast("麦克风已开启。", "success");
    } catch (error) {
      showToast(
        "麦克风开启失败，请检查设备和浏览器权限。",
        "error"
      );
    }
  }

  muteButton.addEventListener("click", async () => {
    if (!localStream) {
      await requestMicrophoneInRoom();
      return;
    }

    isMuted = !isMuted;

    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });

    updateMuteButton();
    renderPeerList();

    showToast(
      isMuted ? "麦克风已关闭。" : "麦克风已开启。",
      "success"
    );
  });

  // ---------- 成员列表 ----------

  function createPeerCard(
    name,
    state,
    avatarText,
    extraClass = "",
    indicatorClass = ""
  ) {
    const card = document.createElement("div");

    card.className = `peer-card ${extraClass}`.trim();

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = avatarText;

    const info = document.createElement("div");
    info.className = "peer-info";

    const nameElement = document.createElement("strong");
    nameElement.textContent = name;

    const stateElement = document.createElement("span");
    stateElement.className = "peer-state";
    stateElement.textContent = state;

    info.append(nameElement, stateElement);

    const indicator = document.createElement("span");
    indicator.className =
      `peer-indicator ${indicatorClass}`.trim();

    card.append(avatar, info, indicator);

    return card;
  }

  function renderPeerList() {
    const selfState = !localStream
      ? "尚未开启麦克风"
      : isMuted
        ? "麦克风已关闭"
        : "麦克风已开启";

    const selfIndicator = localStream && !isMuted
      ? "online"
      : "muted";

    const selfCard = createPeerCard(
      "老大",
      selfState,
      "☾",
      "self-card",
      selfIndicator
    );

    peerList.replaceChildren(selfCard);

    const ids = [...knownPeerIds]
      .filter((id) => id !== socket?.id)
      .sort();

    const avatarSymbols = ["✧", "☽", "✦", "♧"];

    ids.forEach((id, index) => {
      const peer = peers.get(id);

      let state = "正在连接……";
      let indicator = "";

      if (peer) {
        const connectionState =
          peer.pc.connectionState;

        if (connectionState === "connected") {
          state = "语音已连接";
          indicator = "online";
        } else if (connectionState === "failed") {
          state = "连接失败";
          indicator = "muted";
        } else if (
          connectionState === "disconnected"
        ) {
          state = "网络波动";
          indicator = "muted";
        } else if (connectionState === "closed") {
          state = "已离开";
        }
      }

      const card = createPeerCard(
        `伙伴 ${index + 1}`,
        state,
        avatarSymbols[index % avatarSymbols.length],
        "",
        indicator
      );

      peerList.appendChild(card);
    });
  }

  // ---------- WebRTC 连接 ----------

  function sendSignal(peerId, type, data) {
    if (!socket || !socket.connected) {
      return;
    }

    socket.emit("signal", {
      to: peerId,
      type,
      data
    });
  }

  function ensurePeer(peerId, initiator = false) {
    if (
      typeof peerId !== "string" ||
      !peerId ||
      peerId === socket?.id
    ) {
      return null;
    }

    let peer = peers.get(peerId);

    if (peer) {
      if (initiator) {
        peer.initiator = true;
      }

      return peer;
    }

    const pc = new RTCPeerConnection(
      rtcConfiguration
    );

    peer = {
      pc,
      initiator,
      polite: String(socket?.id || "")
        .localeCompare(peerId) > 0,

      makingOffer: false,
      isSettingRemoteAnswerPending: false,
      ignoreOffer: false,
      needsOffer: false,

      pendingCandidates: [],

      audioEl: null,
      remoteStream: null
    };

    peers.set(peerId, peer);

    // 有麦克风时发送音轨，否则先建立仅接收音频的通道。
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStream);
      });
    } else {
      pc.addTransceiver("audio", {
        direction: "recvonly"
      });
    }

    // 发送 ICE candidate。
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(
          peerId,
          "ice-candidate",
          event.candidate.toJSON()
        );
      }
    };

    // 接收对方音频。
    pc.ontrack = (event) => {
      let remoteStream = event.streams?.[0];

      if (!remoteStream) {
        if (!peer.remoteStream) {
          peer.remoteStream = new MediaStream();
        }

        if (
          !peer.remoteStream
            .getTracks()
            .includes(event.track)
        ) {
          peer.remoteStream.addTrack(event.track);
        }

        remoteStream = peer.remoteStream;
      } else {
        peer.remoteStream = remoteStream;
      }

      if (!peer.audioEl) {
        const audio = document.createElement("audio");

        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute(
          "aria-label",
          "语音伙伴的音频"
        );

        audioContainer.appendChild(audio);

        peer.audioEl = audio;
      }

      peer.audioEl.srcObject = remoteStream;

      peer.audioEl.play().catch(() => {
        if (!audioPlaybackWarningShown) {
          audioPlaybackWarningShown = true;

          showToast(
            "如果听不到声音，请点击页面后重试播放。",
            "error"
          );
        }
      });
    };

    // 连接状态变化。
    pc.onconnectionstatechange = () => {
      if (!peers.has(peerId)) {
        return;
      }

      renderPeerList();
      updateOverallRoomStatus();

      if (pc.connectionState === "failed") {
        showToast(
          "与一位伙伴的语音连接失败，请检查网络。",
          "error"
        );
      }
    };

    // 信令恢复稳定后，如果有尚未完成的协商，则继续处理。
    pc.onsignalingstatechange = () => {
      if (
        pc.signalingState === "stable" &&
        peer.needsOffer &&
        !peer.makingOffer
      ) {
        void createOffer(peerId, peer);
      }
    };

    renderPeerList();

    return peer;
  }

  function closePeer(peerId) {
    const peer = peers.get(peerId);

    if (!peer) {
      return;
    }

    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.onsignalingstatechange = null;

    try {
      peer.pc.close();
    } catch (error) {
      // 连接可能已经关闭。
    }

    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }

    peers.delete(peerId);
  }

  function cleanupPeers() {
    [...peers.keys()].forEach(closePeer);

    peers.clear();
    audioContainer.replaceChildren();
  }

  async function createOffer(peerId, peer) {
    if (!peer || !socket?.connected) {
      return;
    }

    if (peer.makingOffer) {
      peer.needsOffer = true;
      return;
    }

    if (peer.pc.signalingState !== "stable") {
      peer.needsOffer = true;
      return;
    }

    peer.makingOffer = true;
    peer.needsOffer = false;

    try {
      const offer = await peer.pc.createOffer();

      if (peer.pc.signalingState !== "stable") {
        peer.needsOffer = true;
        return;
      }

      await peer.pc.setLocalDescription(offer);

      const description = {
        type: peer.pc.localDescription.type,
        sdp: peer.pc.localDescription.sdp
      };

      sendSignal(peerId, "offer", description);
    } catch (error) {
      peer.needsOffer = true;

      console.error("创建语音连接失败：", error);

      showToast(
        "建立语音连接失败，请稍后重试。",
        "error"
      );
    } finally {
      peer.makingOffer = false;
    }
  }

  async function flushPendingCandidates(peer) {
    const candidates = peer.pendingCandidates.splice(0);

    for (const candidate of candidates) {
      if (peer.ignoreOffer) {
        continue;
      }

      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (error) {
        if (!peer.ignoreOffer) {
          console.warn(
            "处理 ICE candidate 失败：",
            error
          );
        }
      }
    }
  }

  async function handleSignal(message) {
    if (
      !message ||
      typeof message.from !== "string"
    ) {
      return;
    }

    const peerId = message.from;

    if (peerId === socket?.id) {
      return;
    }

    // 信令来自同一房间的成员。
    if (!knownPeerIds.has(peerId)) {
      knownPeerIds.add(peerId);
      renderPeerList();
    }

    const peer = ensurePeer(peerId, false);

    if (!peer) {
      return;
    }

    const pc = peer.pc;
    const { type, data } = message;

    if (type === "ice-candidate") {
      if (!data || peer.ignoreOffer) {
        return;
      }

      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(data);
        } else {
          peer.pendingCandidates.push(data);
        }
      } catch (error) {
        if (!peer.ignoreOffer) {
          console.warn(
            "添加 ICE candidate 失败：",
            error
          );
        }
      }

      return;
    }

    if (
      type !== "offer" &&
      type !== "answer"
    ) {
      return;
    }

    if (
      !data ||
      typeof data.type !== "string" ||
      typeof data.sdp !== "string"
    ) {
      return;
    }

    try {
      // 处理双方同时发起协商时可能出现的 offer 冲突。
      const readyForOffer =
        !peer.makingOffer &&
        (
          pc.signalingState === "stable" ||
          peer.isSettingRemoteAnswerPending
        );

      const offerCollision =
        type === "offer" && !readyForOffer;

      peer.ignoreOffer =
        !peer.polite && offerCollision;

      if (peer.ignoreOffer) {
        return;
      }

      peer.isSettingRemoteAnswerPending =
        type === "answer";

      await pc.setRemoteDescription(data);

      peer.isSettingRemoteAnswerPending = false;

      await flushPendingCandidates(peer);

      if (type === "offer") {
        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        sendSignal(peerId, "answer", {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp
        });
      }
    } catch (error) {
      peer.isSettingRemoteAnswerPending = false;

      if (!peer.ignoreOffer) {
        console.error("处理语音信令失败：", error);

        showToast(
          "语音协商出现问题，请重新连接房间。",
          "error"
        );
      }
    }
  }

  // 麦克风尚未准备好时，先收集成员和信令事件。
  async function flushPendingEvents() {
    if (!mediaReady) {
      return;
    }

    const initialUsers = pendingRoomUsers.splice(0);

    for (const peerId of initialUsers) {
      if (knownPeerIds.has(peerId)) {
        ensurePeer(peerId, false);
      }
    }

    const joins = [...pendingPeerJoins];

    pendingPeerJoins.clear();

    for (const peerId of joins) {
      if (!knownPeerIds.has(peerId)) {
        continue;
      }

      const peer = ensurePeer(peerId, true);

      if (peer) {
        await createOffer(peerId, peer);
      }
    }

    const signals = pendingSignals.splice(0);

    for (const message of signals) {
      if (
        message &&
        knownPeerIds.has(message.from)
      ) {
        await handleSignal(message);
      }
    }

    renderPeerList();
    updateOverallRoomStatus();
  }

  // ---------- Socket.IO ----------

  function resetPendingState() {
    mediaReady = false;
    knownPeerIds.clear();

    pendingRoomUsers = [];
    pendingPeerJoins.clear();
    pendingSignals = [];
  }

  function handleConnectError(activeSocket, error) {
    if (socket !== activeSocket) {
      return;
    }

    const message =
      error?.message || "连接失败，请稍后重试。";

    socket = null;

    activeSocket.removeAllListeners();
    activeSocket.disconnect();

    cleanupPeers();
    resetPendingState();
    stopLocalStream();

    loginScreen.hidden = false;
    roomScreen.hidden = true;

    setLoginButtonState(false, "进入房间");
    setLoginError(message);
    setConnectionStatus("连接失败", "error");

    lastPassword = "";
    joiningRejected = false;
    roomErrorMessage = "";
  }

  function connectToRoom(password) {
    if (typeof io !== "function") {
      setLoginError(
        "语音客户端加载失败，请刷新网页后重试。"
      );

      setConnectionStatus("加载失败", "error");

      return;
    }

    lastPassword = password;
    joiningRejected = false;
    roomErrorMessage = "";

    cleanupPeers();
    resetPendingState();

    setLoginError("");
    setLoginButtonState(true, "正在连接……");
    setConnectionStatus("正在连接");

    const activeSocket = io({
      autoConnect: false,
      auth: {
        password
      }
    });

    socket = activeSocket;

    activeSocket.on("connect", () => {
      if (socket !== activeSocket) {
        return;
      }

      setConnectionStatus("已连接服务器", "connected");
    });

    activeSocket.on("connect_error", (error) => {
      handleConnectError(activeSocket, error);
    });

    // 成功加入房间后，服务器会发送现有成员列表。
    activeSocket.on("room-users", (userIds) => {
      if (socket !== activeSocket) {
        return;
      }

      const ids = Array.isArray(userIds)
        ? userIds.filter(
            (id) =>
              typeof id === "string" &&
              id !== activeSocket.id
          )
        : [];

      knownPeerIds = new Set(ids);
      pendingRoomUsers = [...ids];

      loginScreen.hidden = true;
      roomScreen.hidden = false;

      setLoginButtonState(false, "进入房间");
      setLoginError("");
      setConnectionStatus("已连接", "connected");

      updateMuteButton();
      renderPeerList();

      if (localStream) {
        // 麦克风已经存在，例如用户刚刚重新授权。
        mediaReady = true;
        void flushPendingEvents();
      } else {
        void startRoomMedia(activeSocket);
      }
    });

    // 新成员加入：当前客户端负责发起连接。
    activeSocket.on("peer-joined", (data) => {
      if (
        socket !== activeSocket ||
        !data ||
        typeof data.id !== "string"
      ) {
        return;
      }

      const peerId = data.id;

      if (peerId === activeSocket.id) {
        return;
      }

      knownPeerIds.add(peerId);

      if (mediaReady) {
        const peer = ensurePeer(peerId, true);

        if (peer) {
          void createOffer(peerId, peer);
        }
      } else {
        pendingPeerJoins.add(peerId);
      }

      renderPeerList();
      updateOverallRoomStatus();
    });

    // 接收其他客户端发来的 SDP 和 ICE 信息。
    activeSocket.on("signal", (message) => {
      if (socket !== activeSocket) {
        return;
      }

      if (!mediaReady) {
        pendingSignals.push(message);
      } else {
        void handleSignal(message);
      }
    });

    activeSocket.on("peer-left", (data) => {
      if (
        socket !== activeSocket ||
        !data ||
        typeof data.id !== "string"
      ) {
        return;
      }

      const peerId = data.id;

      knownPeerIds.delete(peerId);
      pendingPeerJoins.delete(peerId);

      pendingSignals = pendingSignals.filter(
        (message) => message?.from !== peerId
      );

      closePeer(peerId);

      renderPeerList();
      updateOverallRoomStatus();
    });

    activeSocket.on("room-count", (data) => {
      if (socket !== activeSocket || !data) {
        return;
      }

      updateRoomCount(Number(data.count));
    });

    activeSocket.on("room-error", (data) => {
      if (socket !== activeSocket) {
        return;
      }

      joiningRejected = true;

      roomErrorMessage =
        data?.message || "无法加入语音房间。";

      showToast(roomErrorMessage, "error");

      activeSocket.disconnect();
    });

    activeSocket.on("disconnect", () => {
      if (socket !== activeSocket) {
        return;
      }

      const message = joiningRejected
        ? roomErrorMessage
        : "连接已断开，请重新登录。";

      returnToLogin(message);
    });

    activeSocket.connect();
  }

  function returnToLogin(message = "") {
    const oldSocket = socket;

    socket = null;

    if (oldSocket) {
      oldSocket.removeAllListeners();
      oldSocket.disconnect();
    }

    cleanupPeers();
    resetPendingState();
    stopLocalStream();

    loginScreen.hidden = false;
    roomScreen.hidden = true;

    setLoginButtonState(false, "进入房间");
    setLoginError(message);

    setConnectionStatus(
      message ? "连接已断开" : "等待连接",
      message ? "error" : ""
    );

    lastPassword = "";
    joiningRejected = false;
    roomErrorMessage = "";
  }

  // ---------- 登录 ----------

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const password = passwordInput.value;

    if (!password) {
      setLoginError("请输入房间口令。");
      return;
    }

    connectToRoom(password);
  });

  togglePasswordButton.addEventListener("click", () => {
    const showing =
      passwordInput.type === "password";

    passwordInput.type = showing
      ? "text"
      : "password";

    togglePasswordButton.textContent =
      showing ? "◎" : "◉";

    togglePasswordButton.setAttribute(
      "aria-label",
      showing ? "隐藏口令" : "显示口令"
    );
  });

  // ---------- 背景图片 ----------

  wallpaperInput.addEventListener("change", () => {
    const file = wallpaperInput.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      showToast("请选择图片文件。", "error");
      wallpaperInput.value = "";
      return;
    }

    // 限制为 8 MB，避免加载过大的本地图片。
    if (file.size > 8 * 1024 * 1024) {
      showToast(
        "图片太大啦，请选择小于 8 MB 的图片。",
        "error"
      );

      wallpaperInput.value = "";
      return;
    }

    if (wallpaperObjectUrl) {
      URL.revokeObjectURL(wallpaperObjectUrl);
    }

    wallpaperObjectUrl = URL.createObjectURL(file);

    document.documentElement.style.setProperty(
      "--wallpaper-image",
      `url("${wallpaperObjectUrl}")`
    );

    showToast(
      "背景已更换，仅在当前浏览器中生效。",
      "success"
    );

    wallpaperInput.value = "";
  });

  // ---------- 离开房间 ----------

  leaveButton.addEventListener("click", () => {
    returnToLogin("");

    passwordInput.value = "";

    showToast("已离开语音小屋。", "success");
  });

  // 浏览器关闭或刷新时释放本地媒体资源。
  window.addEventListener("beforeunload", () => {
    if (socket) {
      socket.disconnect();
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        track.stop();
      });
    }

    cleanupPeers();

    if (wallpaperObjectUrl) {
      URL.revokeObjectURL(wallpaperObjectUrl);
    }
  });

  // 如果浏览器暂时阻止音频自动播放，用户点击页面后重试。
  document.addEventListener(
    "click",
    () => {
      for (const peer of peers.values()) {
        if (peer.audioEl && peer.audioEl.paused) {
          peer.audioEl.play().catch(() => {});
        }
      }
    },
    true
  );

  // ---------- 初始化 ----------

  updateMuteButton();
  renderPeerList();

  setConnectionStatus("等待连接");
})();
