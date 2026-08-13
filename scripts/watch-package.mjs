import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const children = [
  spawn(command, ["exec", "vite", "build", "--watch"], {
    stdio: "inherit",
  }),
  spawn(command, ["exec", "tsc", "-p", "tsconfig.build.json", "--watch"], {
    stdio: "inherit",
  }),
];

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const exitCode = await new Promise((resolve) => {
  let remaining = children.length;
  let code = 0;
  for (const child of children) {
    child.once("exit", (childCode) => {
      code = code || childCode || 0;
      remaining -= 1;
      if (childCode && !stopping) stop("SIGTERM");
      if (remaining === 0) resolve(code);
    });
  }
});

process.exitCode = exitCode;
