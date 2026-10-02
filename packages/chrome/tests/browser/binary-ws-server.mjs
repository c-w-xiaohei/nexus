import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { deflateSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { Nexus } from "@nexus-js/core";
import { WebSocketServerEndpoint } from "@nexus-js/websocket/server";
import { BinaryImageToken } from "./extension/shared/contracts.ts";

const imageBytes = createPng();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let imageInvocationCount = 0;
let uploadCount = 0;
let binaryMessageCount = 0;
let outboundBinaryMessageCount = 0;
let webSocketConnectionCount = 0;
let activeWebSocketCount = 0;
let holdInvocationCount = 0;
let holdResolvedCount = 0;
let imageResponseBaselineBytes;
let outboundBinaryBytes = 0;
const holdWaiters = new Set();
const service = {
  async getImage() {
    imageInvocationCount += 1;
    imageResponseBaselineBytes = outboundBinaryBytes;
    return { bytes: imageBytes, mimeType: "image/png" };
  },
  async upload(file, callback) {
    uploadCount += 1;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      sha256: hash(bytes),
      callbackResult: await callback(hash(bytes)),
      mimeType: file.type,
    };
  },
  async hold() {
    holdInvocationCount += 1;
    return await new Promise((resolve) => {
      holdWaiters.add(() => {
        holdResolvedCount += 1;
        resolve("released");
      });
    });
  },
};
const endpoint = new WebSocketServerEndpoint();
const nexus = new Nexus().configure({
  endpoint: { meta: { context: "websocket-server" }, implementation: endpoint },
  providers: [{ token: BinaryImageToken, service }],
});
await nexus.ready();

const server = createServer((request, response) => {
  if (request.url === "/target") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(targetInfo));
    return;
  }
  if (request.url === "/stats") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        imageInvocationCount,
        uploadCount,
        binaryMessageCount,
        outboundBinaryMessageCount,
        outboundBinaryBytes,
        imageResponseBinaryBytes:
          imageResponseBaselineBytes === undefined
            ? 0
            : outboundBinaryBytes - imageResponseBaselineBytes,
        webSocketConnectionCount,
        activeWebSocketCount,
        holdInvocationCount,
        holdResolvedCount,
        imageSha256: hash(imageBytes),
      }),
    );
    return;
  }
  if (request.url === "/reset" && request.method === "POST") {
    imageInvocationCount = 0;
    uploadCount = 0;
    binaryMessageCount = 0;
    outboundBinaryMessageCount = 0;
    webSocketConnectionCount = 0;
    imageResponseBaselineBytes = undefined;
    outboundBinaryBytes = 0;
    holdInvocationCount = 0;
    holdResolvedCount = 0;
    response.end("ok");
    return;
  }
  if (request.url === "/release-holds" && request.method === "POST") {
    for (const release of holdWaiters) release();
    holdWaiters.clear();
    response.end("ok");
    return;
  }
  response.end("ws-host-ready");
});
let targetInfo;
const sockets = new Set();
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) => {
  webSocketConnectionCount += 1;
  activeWebSocketCount += 1;
  socket.once("close", () => {
    activeWebSocketCount -= 1;
  });
  socket.on("message", (_data, binary) => {
    if (binary) binaryMessageCount += 1;
  });
});
const wsServer = createServer();
wsServer.on("upgrade", (request, socket, head) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    const send = webSocket.send.bind(webSocket);
    webSocket.send = (data, options, callback) => {
      const isBinary =
        options?.binary === true ||
        (options?.binary === undefined &&
          (Buffer.isBuffer(data) ||
            data instanceof ArrayBuffer ||
            ArrayBuffer.isView(data)));
      if (isBinary) {
        outboundBinaryMessageCount += 1;
        outboundBinaryBytes += byteLength(data);
      }
      return send(data, options, callback);
    };
    endpoint.attach(webSocket, {});
    wss.emit("connection", webSocket, request);
  });
});
wsServer.listen(0, "127.0.0.1");
await once(wsServer, "listening");
const address = wsServer.address();
if (!address || typeof address === "string")
  throw new Error("Expected a loopback WebSocket port");
const target = {
  url: `ws://127.0.0.1:${address.port}`,
  httpUrl: `http://127.0.0.1:${address.port}`,
};
targetInfo = target;
server.listen(4176, "127.0.0.1");
await once(server, "listening");

async function close() {
  endpoint.close();
  for (const socket of sockets) socket.destroy();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  server.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => wsServer.close(resolve)),
  ]);
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function byteLength(data) {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

function createPng() {
  const width = 320;
  const height = 180;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = (x * 73 + y * 19) % 256;
      pixels[offset + 1] = (x * 31 + y * 101) % 256;
      pixels[offset + 2] = (x * 127 + y * 47) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk(
      "IHDR",
      Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])]),
    ),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([
    u32(data.length),
    name,
    data,
    u32(crc32(Buffer.concat([name, data]))),
  ]);
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
