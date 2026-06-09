export type SenderAllowlist = ReadonlySet<string> | undefined;

export function parseSenderAllowlist(value: string | undefined): SenderAllowlist {
  if (!value?.trim()) return undefined;
  const entries = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : undefined;
}

export function senderAllowed(senderIdentity: string, allowlist: SenderAllowlist): boolean {
  return !allowlist || allowlist.has(senderIdentity);
}
