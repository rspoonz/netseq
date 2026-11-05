// `bun run dev`: the API server (restarts when its files change) plus the Vite dev server.
const children = [
  Bun.spawn([process.execPath, "--watch", "server/main.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn([process.execPath, "x", "vite"], { stdout: "inherit", stderr: "inherit" }),
];

function stopAll(): void {
  for (const child of children) child.kill();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}

// If either one exits, stop the other as well.
await Promise.race(children.map((child) => child.exited));
stopAll();
