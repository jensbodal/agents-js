import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PromptChoice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface PromptSession {
  close(): void;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  input(message: string, defaultValue?: string): Promise<string>;
  select<T extends string>(message: string, options: PromptChoice<T>[]): Promise<T>;
}

function formatOption<T extends string>(choice: PromptChoice<T>, index: number): string {
  if (!choice.hint) {
    return `  ${index + 1}. ${choice.label}`;
  }
  return `  ${index + 1}. ${choice.label} — ${choice.hint}`;
}

export function createTerminalPromptSession(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): PromptSession {
  const rl = createInterface({
    input,
    output,
  });

  return {
    close() {
      rl.close();
    },
    async confirm(message, defaultValue = true) {
      const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";

      while (true) {
        const answer = (await rl.question(`${message}${suffix}`)).trim().toLowerCase();
        if (answer === "") {
          return defaultValue;
        }
        if (answer === "y" || answer === "yes") {
          return true;
        }
        if (answer === "n" || answer === "no") {
          return false;
        }
        output.write("Enter y or n.\n");
      }
    },
    async input(message, defaultValue) {
      const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${message}${suffix}: `)).trim();
      return answer === "" ? (defaultValue ?? "") : answer;
    },
    async select(message, options) {
      output.write(`${message}\n`);
      options.forEach((option, index) => {
        output.write(`${formatOption(option, index)}\n`);
      });

      while (true) {
        const answer = (await rl.question("> ")).trim();
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          // biome-ignore lint/style/noNonNullAssertion: index is bounds-checked on the line above; optional chaining would break the return type
          return options[index - 1]!.value;
        }
        output.write("Enter one of the listed numbers.\n");
      }
    },
  };
}
