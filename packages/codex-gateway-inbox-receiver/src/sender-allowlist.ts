export type SenderAllowlist = ReadonlySet<string>;

export function parseSenderAllowlist(value: string | undefined): SenderAllowlist {
  if (!value?.trim()) return new Set();
  const entries = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set(entries);
}

export function senderAllowed(senderIdentity: string, allowlist: SenderAllowlist): boolean {
  return allowlist.has(senderIdentity);
}
