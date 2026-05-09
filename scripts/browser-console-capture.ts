export function buildBrowserConsoleInitScript(): string {
  return `
() => {
  const toText = (value) => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const entries = [];
  window.__agentsConsole = entries;
  const push = (level, parts) => {
    entries.push({ level, text: Array.from(parts).map(toText).join(" ") });
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      push(level, args);
      return original(...args);
    };
  }
  window.addEventListener("error", (event) => {
    push("error", [event.message]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    push("error", [String(event.reason)]);
  });
}
`.trim();
}

export function buildBrowserConsoleExportCode(): string {
  return `
async (page) => {
  const entries = await page.evaluate(() => window.__agentsConsole ?? []);
  return entries;
}
`.trim();
}
