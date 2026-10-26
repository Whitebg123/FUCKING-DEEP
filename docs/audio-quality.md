# 语音音质优化、诊断和 A/B 验证

## 检查范围与原有实现

修改前完整检查了 `package.json`、`README.md`、`server.js`、`public/index.html`、`public/style.css`、`public/app.js`，基线为 `caf58864b012b9c5c2d9435d0b38e8aebeacd37e`。

原有音频链路是 `getUserMedia -> addTrack / replaceTrack -> RTCPeerConnection -> 远端 audio.srcObject`，没有 Web Audio 混音、EQ、压缩器、应用增益、重采样或录音转码。两处采集都固定设置回声消除、降噪、自动增益为 true，没有显示实际约束、编码器和网络统计。

每位参与者与其他成员分别建立连接。五人时共十条双向连接，本机最多向四人发送。Render 保持原有网页及 Socket.IO 信令职责。登录口令、失败次数限制、固定房间、五人上限、静音、背景图片、接收模式、perfect negotiation 与候选缓冲流程保留；服务端及依赖不需要修改。

## 实际采用的参数

| 项目 | 设置 | 生效证据与边界 |
| --- | --- | --- |
| 回声消除 | 默认请求 true，可单独切换 | 扬声器场景保留保护；耳机用户可比较关闭后的听感。是否生效看 track.getSettings() |
| 降噪 | 默认请求 false，可单独切换 | 降低过度噪声处理的可能；安静环境优先，机械键盘或风扇明显时再单独开启 |
| 自动增益 | 默认请求 false，可单独切换 | 避免浏览器反复拉升／压低音量；输入太小或削波应先调整设备输入增益和距离 |
| 采集声道 | 支持时请求 channelCount: {ideal: 1} | 只表达偏好，不强制设备；实际值显示在面板与诊断快照中 |
| 采集采样率 | 不强制 sampleRate / sampleSize | 不制造设备不兼容，不承诺硬件以 48 kHz 工作 |
| 编码器 | 支持时用 setCodecPreferences 将原始 Opus 能力项排在前面 | 保留其他编码与冗余能力项；不支持或被拒绝则保留浏览器默认协商，以 RTP 统计中的 codecId 为准 |
| 发送上限 | 默认请求 64000 bits/s；可选 48000、32000、浏览器自动 | 对每条音频 sender 的现有 encoding 设置 maxBitrate；协商稳定、补入音轨、连接成功后重新应用并回读 |
| VBR / FEC / DTX / ptime | 不覆盖浏览器与对端协商结果 | 没有改写 SDP 或 codecs/fmtp，没有强制 CBR、禁用 FEC、修改包时长或不兼容的 dtx 属性 |
| 应用 DSP / 输出增益 | 不添加 | 不对输入进行滤波、压缩、归一化、混合、缓冲或额外增益 |

所有采集请求都先经过 `getSupportedConstraints()` 筛选，用 `ideal` 表达偏好。`getCapabilities()` 可用时进一步标记当前设备无法切换的功能。`getSettings()` 返回实际值；缺失时明确显示“浏览器未报告”，不会将 `applyConstraints()` 成功等同于三个处理项全部生效。

处理设置变化时对现有音轨串行调用 `applyConstraints()`，不重新创建麦克风或 PeerConnection，不解除静音。应用失败会显示错误并保留当前音轨，可离开后重新进入以在采集时请求新设置。偏好只保存到本机 localStorage，不保存口令。

码率更新也按每条连接串行执行。每次均重新读取 `getParameters()`，不虚构 encodings，不修改 transactionId、payloadType、codec 或 fmtp。协商前 encodings 为空时标记等待，之后重试；API 不支持、拒绝或回读不一致时分别标明，保持浏览器可用配置。

64 kbps 是每位伙伴的应用上限，并非编码器必须发送的目标，也不保证听感一定提升。浏览器拥塞控制、对端接收限制、语音内容、静音和 Opus 自身策略仍可能让实际码率更低。五人时 4 × 64 = 256 kbps 是本机发送媒体的上限数量级，IP/UDP/DTLS/SRTP/RTCP 等开销另计。

参数回读一致不能替代发送统计验证。本机合成音源测试中的短时间差分码率可略高于 64 kbps（约 64.3–64.8 kbps）；因此这里没有把浏览器上限当成严格的网络流量整形器，也没有声称任何采样窗口都必定低于 64.000 kbps。

`opus/48000/2` 中的 48000 是 RTP 时钟，2 是 Opus RTP 注册方式／能力声道数，不能据此宣称麦克风采样率、实际声音带宽或双声道发送。Opus 默认的 stereo 接收偏好为 0；本实现优先单声道源，不改写 SDP 来硬改通道数。双方都应查看各自采集实际声道与协商 fmtp。

fmtp 中的 `useinbandfec=1` 表示协商允许的 FEC 能力或偏好，不等于每个包正在使用 FEC；实际使用仍由编码器和网络决定。DTX 的缺省与未报告不代表强制启用；没有把这些优化功能一概关闭。

## 当前文件职责

| 文件 | 修改原因 |
| --- | --- |
| public/audio-quality.js（新增） | 集中处理兼容采集偏好、实际值显示、Opus 优先、发送上限、统计和不含敏感字段的诊断导出 |
| public/app.js | 两处采集复用约束构造；在原有协商／补轨流程中配置编码器和发送端；补上异步采集与旧连接关闭后的会话校验 |
| public/index.html | 按顺序加载新脚本；添加原生折叠面板、三项开关、码率选择与诊断显示 |
| public/style.css | 仅追加设置面板样式，沿用现有淡紫色主题、原生控件和窄屏布局 |
| README.md | 补充启动、设置入口、验证和详细文档索引 |
| .gitignore（新增） | 排除依赖、本机环境变量和临时测试结果 |
| tests/audio-quality.test.cjs（新增） | 验证不支持／拒绝／未报告情况、串行更新、统计计算和导出字段 |
| tests/browser-server.cjs（新增） | 在本机回环接口运行原有服务端代码与测试页面，不改生产服务 |
| tests/browser.html（新增） | 可直接点击运行的真实浏览器集成测试入口 |
| tests/browser-runner.js（新增） | 自动操作测试客户端，验证认证、人数上限、全互连、重协商、静音与资源释放 |
| tests/synthetic-media.js（新增） | 仅供本地测试的合成音源与故障模拟；不进入生产采集链路 |
| docs/audio-quality.md（新增） | 完整说明、参数边界、诊断方法、A/B 与部署步骤 |

## 开发者工具检查方法

两名以上成员进入后，展开声音设置面板。仅在面板展开且页面可见时约每 2 秒采样，默认不持续运行统计循环；不会录音或上传诊断数据。

在控制台运行：

```js
// 请求偏好、已知支持能力、采集实际值；不包含设备名或 deviceId。
voiceDiagnostics.capture();

// 第一次采样可能没有差值。间隔至少两秒后再次运行以查看实际码率。
const report = await voiceDiagnostics.snapshot();
console.table(report.peers.flatMap(peer => peer.outbound.map(stream => ({
  peer: peer.peer,
  codec: stream.codec?.mimeType,
  rtpClock: stream.codec?.clockRate,
  fmtp: stream.codec?.sdpFmtpLine,
  actualKbps: stream.kbps,
  targetKbps: stream.targetKbps,
  remoteLossPercent: stream.remoteLossPercent,
  rtcpRttMs: stream.rtcpRttMs
}))));
console.log(report.peers.map(peer => peer.senders));
```

上述方法为只读诊断；更改返回的对象不会改变通话。页面可导出 `voice-diagnostics.json`。快照只包含白名单设置和统计，不含口令、socket ID、设备标识、IP、完整 SDP 或录音。导出的实时统计仍应按个人数据自行管理。

Chrome / Edge：通话前另开 `chrome://webrtc-internals`（Edge 使用 `edge://webrtc-internals`）。检查该页面对应的 PeerConnection：

1. `getUserMedia` 请求与 track 实际值，核对三个处理项。
2. `outbound-rtp.codecId` 和 `inbound-rtp.codecId` 指向的 codec，确认 `audio/opus`、`clockRate=48000` 和 fmtp。
3. sender 的 `encodings[].maxBitrate` 是否在本网页显示“参数回读一致”；这个回读只是参数确认，实际码率仍看计数差值。
4. 发送媒体码率采用 `8 × ΔbytesSent / Δtimestamp(ms)`，数值单位为 kbps；接收同理。不要拿累计字节当瞬时码率，也不要将 ICE candidate-pair 字节当纯音频码率。
5. 接收丢包率为 `ΔpacketsLost / (ΔpacketsLost + ΔpacketsReceived)`；首个采样、计数重置或丢包计数因迟到包回落时显示未知。对端报告丢包来自关联的 remote-inbound-rtp.fractionLost；它是对端 RTCP 报告对应时间段的数据，不是假定与本机两秒采样完全同步。报告时间差也会显示。
6. jitter、RTCP roundTripTime 和 ICE currentRoundTripTime 原单位为秒，面板转换为毫秒。ICE RTT 是连通性检查，RTCP RTT 是媒体反馈往返，二者都不是嘴到耳延迟。
7. `ΔjitterBufferDelay / ΔjitterBufferEmittedCount` 是接收端本采样间隔的平均缓冲时间；`ΔconcealedSamples / ΔtotalSamplesReceived` 提示丢包／迟到后的补偿程度，不能单凭它诊断麦克风音质。

Firefox 可使用 `about:webrtc`，同时使用页面的跨浏览器诊断面板。Safari 可在 Web Inspector 控制台运行上述方法；字段缺失和 API 拒绝会保留为未知或不支持。没有将 Chrome 的验证结果外推为 Safari／Firefox 已通过。

浏览器原生 webrtc-internals 完整转储可能包含网络地址、SDP 等信息，分享前自行检查；页面导出的白名单诊断更适合对比。

## 简单 A/B 测试（需要两台真实设备）

两端佩戴同一套日常游戏耳机；每轮使用相同浏览器版本、麦克风、系统输入增益、嘴到麦克风距离、游戏负载和网络。关闭其他语音软件的监听或重复设备效果；不要边用 TS3 占用麦克风边给浏览器做直接对比。系统或耳机驱动的降噪、自动增益可能位于浏览器之外，网页无法保证将其关闭。

1. 先让双方进入并热身 30 秒。每轮持续 60–90 秒：自然讲话、轻声、音量较大的讲话、句间停顿、敲键盘各一段。两端保持输出音量一致，不以“更响”作为改善。
2. 固定两轮发送上限都为 64 kbps。A 点“原版处理 · 三项全开”；B 点“耳机推荐处理”。由对端记录自然度、齿音／辅音细节、发闷、机械声、背景噪声、音量跳变、爆音／削波，评分 1–5。交错进行 ABBA，尽量由听者不知道当前设置。
3. 若 B 明显不同，再只改变一个处理项定位：保留回声消除，先单独关 AGC，再单独关 NS。耳机且没有外放时才比较 AEC 开／关；扬声器场景保留 AEC。每轮核对实际值，未生效的开关不算有效 A/B。
4. 固定最自然的处理组合，再单独比较“浏览器自动”和 64／48 kbps 上限。记录实际码率、对端丢包、jitter、RTT、补偿比例，先判断网络再解释听感。若浏览器原先发送低于上限，增大上限未必产生任何变化。
5. 按两人、三人、五人分别测试，包含持续讲话、同时讲话、静音／取消静音、离开再进入、拒绝一次麦克风权限后重新开启。对端应能听到每位成员。
6. 延迟先做稳定环境下的交替对话，观察抢话和长停顿。要测嘴到耳数值，需声学／外部录音方法并扣除设备影响；RTT 不能直接替代。CPU 用 Chrome 任务管理器或系统活动监视器，在同样游戏负载下各取 60 秒平均值；一次只比较一个配置，避免把同一台机器运行五个测试客户端的 CPU 当作单用户负载。
7. 保存各轮诊断与听者评分。有丢包／补偿增加或缓冲显著变大，先排查 Wi-Fi、上行拥堵、游戏上传；若网络稳定但声音发闷／音量抽动，优先比较处理开关和设备效果。

新旧版本的整体对比还可以在本机用基线提交与当前版本分别运行。不要在同一公网房间混用两个不同信令服务，然后将连接差异当作纯音质对比。

## Render 操作与回滚

没有新增环境变量、付费服务、数据库或媒体中继要求。现有 `ROOM_PASSWORD` 保留；`PORT` 继续由 Render 提供。免费实例与现有区域不需更改。

仓库更新后，若服务未自动部署：

1. 打开 Render 中 `fucking-deep` 服务。
2. 选择 **Manual Deploy → Deploy latest commit**，确认目标是含音质优化的最新 main 提交。
3. 等待 **Live**，访问 `/health`，再刷新网页；必要时强制刷新以避免旧脚本缓存。
4. 展开“声音设置与连接诊断”，确认看到三项开关和码率选择。已进入房间的旧页面需刷新才会加载新代码。

公开 Git 仓库的自动部署能力受 Render 的连接方式限制，应以该服务实际显示的部署提交为准。不要为了本次前端修改重新创建服务或更改口令。

如需回滚，在 Render 的部署历史选择先前可回滚的成功部署；或在 GitHub 对音质优化提交做 `git revert` 后重新部署。只读诊断和本机设置面板不改变服务端房间数据结构。

## 验证范围与剩余限制

2026-10-26 的本地验证结果：

| 检查 | 结果 |
| --- | --- |
| 所有生产／测试 JS 语法和 git diff --check | 通过 |
| Node 22.23.3 兼容性单元测试 | 7/7 通过 |
| Chromium 156 原生 WebRTC + 合成采集 + 显式回环候选夹具 | 12/12 通过 |
| 五人全双工 | 每人四条 PeerConnection，20 个发送方向均有 Opus/48000 RTP 与接收字节；每个 sender 的 64000 参数回读一致 |
| 在通话中切换三项处理、48 kbps 与自动模式 | 通过，原音轨与静音状态保留（采集处理实际效果仅为模拟） |
| 断开／离开／重登、仅接收成员补入麦克风、两端同时补入麦克风 | 通过；最后一次观察到两次 offer 冲突并成功恢复稳定 |
| 第六人加入、错误口令、离开期间仍在等待采集的旧请求 | 正确拒绝或释放，没有遗留合成音轨或 PeerConnection |
| 320 CSS 像素窄屏 | 文档宽度 320，无横向溢出，三个原生开关和码率选择可见 |
| 日常 Chrome 155 的重复测试 | 曾完成前 10 项；后续运行出现测试 iframe 初始化超时，因此不宣称该配置下整套 12 项通过 |
| 原始 mDNS 候选、真实硬件听感／公网 NAT | 原始候选在本机原版和新版均失败；其余需真实设备实测 |

兼容性单元测试覆盖：不支持约束时的降级、偏好数据校验、实际值不同／缺失、applyConstraints 拒绝、快速开关串行执行且保持静音、Opus 原始能力与回退项保留、空 encodings 等待、码率回读／拒绝／移除、统计差值与未知值、对端统计关联、诊断白名单。

浏览器集成测试使用原有 server.js 的实际信令逻辑和 Chrome 的原生 WebRTC，麦克风替换为本机合成音轨；只在回环地址监听，输出静音。测试代码不在 public 目录，生产网页不会加载它。测试中的处理参数回读由合成采集适配器模拟，不能用于证明真实设备支持 AEC／NS／AGC。

在本机的普通候选测试中，原版与修改版都在 ICE 阶段失败，双方仅生成 mDNS UDP host 候选；信令协商稳定。为继续隔离验证媒体和应用状态，测试入口提供一个显式勾选的 **Test-only loopback ICE address fixture**：只在本机测试客户端的候选序列化处将 host 地址转为 127.0.0.1，不修改 SDP、生产 app.js 或浏览器隐私设置。这种情况下通过的测试证明本机回环夹具下的原生 WebRTC 编码、RTP 和多人状态流程，不能证明原始 mDNS 路径、真实 NAT 或公网连通性已通过。未勾选时仍运行原始候选流程。

实际浏览器测试结果、版本、通过项和限制以交付的验证记录为准。真实耳机／麦克风听感、硬件 DSP、Safari／Firefox、真实五台设备、跨运营商网络、Wi-Fi 丢包及 TS3 主观对比需要按上述步骤另测。没有承诺参数调整能达到 TS3 完全相同的听感。

项目仍只有 STUN，没有 TURN。部分严格 NAT、企业防火墙或禁用非代理 UDP 的浏览器环境可能无法建立 P2P；码率或音频处理开关不能解决这类连通性问题。本次保持免费和原架构，没有引入必须付费的服务。

## 依据

- [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)：支持约束、ideal 偏好、capabilities、settings 与 applyConstraints。
- [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/)：setCodecPreferences、getParameters / setParameters、maxBitrate 与协商。
- [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)：RTP、remote-inbound、candidate-pair、jitter buffer 和补偿样本统计；部分字段为可选或草案定义。
- [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html)：Opus RTP 时钟、mono/stereo、VBR、FEC、DTX 与 fmtp 语义。
