/**
 * node test/mobile-prompt.test.js  (önce npm run compile)
 */
const assert = require("assert");
const {
  wrapPromptForMobileChannel,
  sanitizeMobileAssistantText,
  shouldApplyMobilePrompt,
  MOBILE_REPLY_CHANNEL,
} = require("../out/mobile-prompt");

const base = wrapPromptForMobileChannel("test mesaj", MOBILE_REPLY_CHANNEL);
assert.ok(base.startsWith("test mesaj"), "kullanıcı metni önce gelmeli");
assert.ok(base.includes("[Mobil uzaktan]"), "mobil bağlam");
assert.ok(!base.includes("---"), "frontmatter ayırıcı yok");
assert.ok(!base.includes("işaretçi"), "işaretçi kelimesi yok");

const cleaned = sanitizeMobileAssistantText(
  "Mesajda istek metni görünmüyor.\nGerçek cevap burada.\n2026-05-26T12:00:00Z"
);
assert.ok(!cleaned.includes("istek metni"), "meta satır silindi");
assert.ok(cleaned.includes("Gerçek cevap"), "asıl cevap kaldı");
assert.ok(!/2026-05-26T/.test(cleaned), "timestamp satırı yok");

const viaClient = wrapPromptForMobileChannel("x", undefined, {
  clientId: "mobile-xyz",
});
assert.ok(shouldApplyMobilePrompt(undefined, "mobile-xyz"));
assert.ok(viaClient.includes("<!--/mobile-remote-->"));

console.log("mobile-prompt.test.js: OK");
