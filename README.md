# FUCKING-DEEP

疆界时物语：供 2–5 人使用的私人 WebRTC 语音小屋。Express + Socket.IO 只负责网页与信令；音频保持浏览器之间的 P2P 全互连。

```sh
npm install
ROOM_PASSWORD='your-room-password' npm start
```

打开 `http://localhost:3000`。公网部署需要 HTTPS；保留 Render 的 `PORT`、`ROOM_PASSWORD`、`npm install --omit=dev`、`npm start` 和 `/health` 配置即可。

声音设置位于页面的“声音设置与连接诊断”面板。默认开启回声消除，关闭降噪和自动增益，优先单声道采集与 Opus，尝试设置每个发送端 64 kbps 上限。设置支持本机保存和通话中切换；以实际值与参数回读为准。

详细实现、参数限制、开发者工具检查、A/B 听音与 Render 操作见 [音质优化与验证说明](docs/audio-quality.md)。

运行兼容性测试：`node --test tests/audio-quality.test.cjs`。

运行真实浏览器合成音源集成测试：`node tests/browser-server.cjs`，然后在 Chrome 打开终端打印的本机地址并点击 **Run tests**。测试不使用真实麦克风，不能证明真实听感或公网网络表现。
