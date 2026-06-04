/**
 * Telefondan gelen CLI istekleri — kısa sistem notu (kullanıcıya yansıtılmaz).
 */

export const MOBILE_REPLY_CHANNEL = "mobile";

const WRAP_SENTINEL = "<!--/mobile-remote-->";

export interface MobilePromptOptions {
  newSession?: boolean;
  clientId?: string;
}

export function isMobileReplyChannel(replyChannel?: string): boolean {
  return replyChannel === MOBILE_REPLY_CHANNEL;
}

export function isMobileClientId(clientId?: string): boolean {
  return typeof clientId === "string" && clientId.startsWith("mobile-");
}

export function shouldApplyMobilePrompt(
  replyChannel?: string,
  clientId?: string
): boolean {
  return isMobileReplyChannel(replyChannel) || isMobileClientId(clientId);
}

export function wrapPromptForMobileChannel(
  text: string,
  replyChannel?: string,
  options?: MobilePromptOptions
): string {
  if (!shouldApplyMobilePrompt(replyChannel, options?.clientId)) {
    return text;
  }
  if (text.includes(WRAP_SENTINEL)) {
    return text;
  }

  const userRequest = text.trim();
  if (!userRequest) {
    return text;
  }

  const sessionHint = options?.newSession
    ? "Yeni oturum."
    : "Devam oturumu.";

  // İstek önce; "---" veya "DOLU" başlığı kullanma (frontmatter / argv kesintisi).
  return `${userRequest}

[Mobil uzaktan] ${sessionHint} Türkçe yanıt; özet + madde listesi yeterli. Meta/yorum yok.
${WRAP_SENTINEL}`;
}

/** Telefona giden nihai metinden meta / spam satırlarını temizle. */
export function sanitizeMobileAssistantText(text: string): string {
  if (!text.trim()) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }
    const low = t.toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}t\d{2}:/i.test(t)) {
      continue;
    }
    if (
      low.includes("istek metni görünmüyor") ||
      low.includes("mesajda metin yok") ||
      low.includes("mesajda istek") ||
      low.includes("somut bir görev") ||
      low.includes("somut görev") ||
      low.includes("işaretleyici") ||
      low.includes("bağlam işaret") ||
      (low.includes("önce") &&
        (low.includes("workspace") ||
          low.includes("chat geçmiş") ||
          low.includes("kontrol ediyorum") ||
          low.includes("tarıyorum")))
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
