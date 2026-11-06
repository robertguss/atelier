// RpcClient expects a Node entry point. Forward stdio to the user's installed
// Pi executable, including standalone binaries, without touching login data.
import { spawn } from "node:child_process";

const child = spawn(
  process.env.ATELIER_PI_PATH ?? "pi",
  process.argv.slice(2),
  { stdio: "inherit" }
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 500);
    timer.unref();
  });
}
