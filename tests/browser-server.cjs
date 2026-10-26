"use strict";
// Local-only integration harness. Runs the real server/signalling source and
// real browser RTCPeerConnections with synthetic audio; never opens a real mic.
const fs = require("node:fs");
const path = require("node:path");
const {createRequire} = require("node:module");
const root = path.resolve(__dirname, "..");
process.env.PORT = process.env.TEST_PORT || "4317";
process.env.ROOM_PASSWORD = "local-synthetic-test-only";
const source = fs.readFileSync(path.join(root, "server.js"), "utf8")
  .replace('server.listen(PORT, "0.0.0.0"', 'server.listen(PORT, "127.0.0.1"');
const {app, server, io} = new Function("require", "__dirname", `${source}\nreturn {app, server, io};`)(createRequire(path.join(root, "server.js")), root);
const express = require("express");
app.get("/test/", (_req, res) => res.sendFile(path.join(__dirname, "browser.html")));
app.get("/test/runner.js", (_req, res) => res.type("js").sendFile(path.join(__dirname, "browser-runner.js")));
app.get("/test/media.js", (_req, res) => res.type("js").sendFile(path.join(__dirname, "synthetic-media.js")));
app.get("/test/socket.js", (_req, res) => res.type("js").send(`
  const realIO = window.io;
  window.io = function(options) { const socket = realIO(options); window.testSocket = socket; return socket; };
`));
app.get("/test/client", (_req, res) => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8")
    .replace('<script src="/socket.io/socket.io.js" defer></script>', '<script src="/test/media.js"></script>\n<script src="/socket.io/socket.io.js" defer></script>\n<script src="/test/socket.js" defer></script>');
  // The production anti-framing header is retained on ordinary routes.
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(html);
});
let latestReport = null;
app.post("/test/report", express.json({limit: "1mb"}), (req, res) => {
  latestReport = req.body;
  if (process.env.TEST_REPORT_PATH) fs.writeFileSync(process.env.TEST_REPORT_PATH, JSON.stringify(latestReport, null, 2));
  console.log(`BROWSER_TEST_RESULT ${latestReport.status}: ${latestReport.steps?.length || 0} checks`);
  res.json({saved: true});
});
app.get("/test/report", (_req, res) => res.json(latestReport || {status: "not-run"}));
function stop() { io.close(); server.close(); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`Open http://127.0.0.1:${process.env.PORT}/test/ and click Run tests.`);
