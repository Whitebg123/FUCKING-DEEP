
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;

// 《疆界时物语》固定语音房间
const ROOM_ID = "jiang-jie-shi-wu-yu-main";
const MAX_USERS = 5;

// 暂时使用默认口令。
// 部署到 Render 后，建议设置 ROOM_PASSWORD 环境变量。
const ROOM_PASSWORD =
  process.env.ROOM_PASSWORD || "jiangjie2026";

// 登录失败限制：同一 IP 十分钟内最多失败 8 次
const loginAttempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 8;

// 安全比较口令
function checkPassword(input) {
  if (typeof input !== "string") {
    return false;
  }

  const supplied = Buffer.from(input, "utf8");
  const expected = Buffer.from(ROOM_PASSWORD, "utf8");

  if (supplied.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(supplied, expected);
}

// 检查登录口令及失败次数
io.use((socket, next) => {
  const ip = socket.handshake.address || "unknown";
  const now = Date.now();

  const recentAttempts = (
    loginAttempts.get(ip) || []
  ).filter((time) => now - time < ATTEMPT_WINDOW_MS);

  if (recentAttempts.length >= MAX_FAILED_ATTEMPTS) {
    loginAttempts.set(ip, recentAttempts);
    return next(
      new Error("尝试次数过多，请十分钟后再试")
    );
  }

  const password = socket.handshake.auth?.password;

  if (!checkPassword(password)) {
    recentAttempts.push(now);
    loginAttempts.set(ip, recentAttempts);

    return next(new Error("口令错误，请检查后重试"));
  }

  loginAttempts.delete(ip);
  next();
});

// 基础安全响应头
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// 提供网页静态文件
app.use(express.static(path.join(__dirname, "public")));

// Render 健康检查接口
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    name: "疆界时物语"
  });
});

// 多人语音房间及 WebRTC 信令
io.on("connection", (socket) => {
  const roomBeforeJoin =
    io.sockets.adapter.rooms.get(ROOM_ID);

  // 限制房间最多五人
  if (roomBeforeJoin && roomBeforeJoin.size >= MAX_USERS) {
    socket.emit("room-error", {
      message: "房间已满，最多同时容纳 5 人"
    });

    setTimeout(() => {
      socket.disconnect(true);
    }, 200);

    return;
  }

  // 加入唯一的语音房间
  socket.join(ROOM_ID);

  const room =
    io.sockets.adapter.rooms.get(ROOM_ID);

  // 告诉新用户目前已经在房间里的用户
  const existingUsers = [...(room || [])].filter(
    (id) => id !== socket.id
  );

  socket.emit("room-users", existingUsers);

  // 通知其他用户有新成员加入
  socket.to(ROOM_ID).emit("peer-joined", {
    id: socket.id
  });

  // 广播当前房间人数
  io.to(ROOM_ID).emit("room-count", {
    count: room ? room.size : 0,
    maxUsers: MAX_USERS
  });

  // 转发 WebRTC offer、answer 和 ICE candidate
  socket.on("signal", (message = {}) => {
    const { to, type, data } = message;

    if (
      typeof to !== "string" ||
      !["offer", "answer", "ice-candidate"].includes(type)
    ) {
      return;
    }

    // 只能向同一房间内的用户转发信令
    const target = io.sockets.sockets.get(to);

    if (!target || !target.rooms.has(ROOM_ID)) {
      return;
    }

    target.emit("signal", {
      from: socket.id,
      type,
      data
    });
  });

  // 用户离开时通知其他成员
  socket.on("disconnect", () => {
    socket.to(ROOM_ID).emit("peer-left", {
      id: socket.id
    });

    const remainingRoom =
      io.sockets.adapter.rooms.get(ROOM_ID);

    io.to(ROOM_ID).emit("room-count", {
      count: remainingRoom ? remainingRoom.size : 0,
      maxUsers: MAX_USERS
    });
  });
});

// 启动 HTTP 服务，Render 会提供 PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `疆界时物语服务器已启动，端口：${PORT}`
  );
});
