import { spawn } from "node:child_process";

export class SmaPhaseTimeout extends Error {
  constructor() { super("SMA refresh phase exceeded its time budget"); }
}

/** A process-group watchdog also stops forked scoring workers on a timeout. */
export function runSmaPhase(args: string[], milliseconds: number): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return Promise.reject(new SmaPhaseTimeout());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: process.platform !== "win32", stdio: "inherit" });
    let timedOut = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      // An uncooperative child cannot carry work beyond the combined deadline.
      // Keep the parent alive through the grace period even if the leader exits
      // before a descendant that ignores SIGTERM.
      setTimeout(() => signalGroup("SIGKILL"), 2000);
    }, milliseconds);
    const interrupted = () => { signalGroup("SIGKILL"); process.exit(130); };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code) => {
      cleanup();
      if (timedOut) reject(new SmaPhaseTimeout());
      else if (code === 0) resolve();
      else reject(new Error(`SMA refresh phase failed with exit code ${code}`));
    });
  });
}
