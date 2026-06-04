import * as fs from "fs";
import * as path from "path";

/** Mobil `insert_text.attachments[]` öğesi */
export interface RemoteAttachmentPayload {
  name: string;
  type: string;
  base64: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 8;
const ATTACH_DIR = ".cursor-remote-attachments";

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base.slice(0, 120) : "file";
}

function workspaceAtRef(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    return absolutePath.replace(/\\/g, "/");
  }
  return rel.startsWith(".") ? `@${rel}` : `@./${rel}`;
}

/**
 * Base64 ekleri workspace altına yazar; CLI prompt'una @ yolları ekler.
 */
export function materializeRemoteAttachments(
  attachments: RemoteAttachmentPayload[] | undefined,
  workspaceRoot: string,
  log: (msg: string) => void
): string {
  if (!attachments?.length) {
    return "";
  }

  const slice = attachments.slice(0, MAX_FILES);
  const batchDir = path.join(
    workspaceRoot,
    ATTACH_DIR,
    `${Date.now()}`
  );
  fs.mkdirSync(batchDir, { recursive: true });

  const lines: string[] = [
    "[Mobil ekler — workspace'e kaydedildi; gerekirse @ ile referans verin]",
  ];

  for (const raw of slice) {
    const name = sanitizeFileName(raw.name || "file");
    const mime = (raw.type || "application/octet-stream").trim();
    const b64 = (raw.base64 || "").trim();
    if (!b64) {
      log(`remote-attachments: skip empty base64 for ${name}`);
      continue;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      log(`remote-attachments: invalid base64 for ${name}`);
      continue;
    }

    if (buf.length > MAX_FILE_BYTES) {
      log(
        `remote-attachments: skip ${name} (${buf.length} bytes > ${MAX_FILE_BYTES})`
      );
      continue;
    }

    const filePath = path.join(batchDir, name);
    fs.writeFileSync(filePath, buf);
    const atRef = workspaceAtRef(workspaceRoot, filePath);
    const label = mime.startsWith("image/")
      ? "Görsel"
      : mime.startsWith("text/")
        ? "Metin dosyası"
        : "Dosya";
    lines.push(`- ${label} ${raw.name || name}: ${atRef}`);
    log(`remote-attachments: saved ${filePath} (${buf.length} bytes)`);
  }

  if (lines.length <= 1) {
    return "";
  }

  lines.push("");
  return lines.join("\n");
}
