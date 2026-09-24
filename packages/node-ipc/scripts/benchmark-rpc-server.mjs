import { Nexus, Token } from "@nexus-js/core";
import { usingNodeIpcDaemon } from "../dist/index.mjs";
import { verifyCodec } from "./benchmark-codec.mjs";

const address = { kind: "path", path: process.argv[2] };
const config = usingNodeIpcDaemon({
  appId: "nexus-bench",
  address,
  configure: false,
});
const daemon = new Nexus().configure(config);
daemon.provide(new Token("bench:node-ipc-echo"), {
  echo: (value) => value,
});

try {
  await daemon.ready();
  verifyCodec();
  process.send?.("ready");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
