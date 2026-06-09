import { execFile } from "node:child_process";

/** Run a shell command and return stdout exactly, preserving multiline PEMs. */
export function runKeyCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", command], { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`key_cmd failed: ${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(stdout.replace(/\s+$/, ""));
    });
  });
}
