/**
 * Paralel CLI koşuları — oturum başına ayrı process anahtarı.
 */
export function resolveCliRunKey(
  clientId: string | undefined,
  resumeSessionId: string | undefined,
  newSession: boolean
): string {
  const sid = resumeSessionId?.trim();
  if (sid) {
    return `sid:${sid}`;
  }
  if (newSession) {
    return `new:${clientId || "global"}:${Date.now()}`;
  }
  return `client:${clientId || "global"}`;
}
