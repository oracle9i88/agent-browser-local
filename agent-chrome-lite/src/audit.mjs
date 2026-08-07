import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async record(event) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const safe = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...event,
    };
    if (Object.hasOwn(safe, "value")) {
      safe.valueLength = String(safe.value).length;
      safe.valueSha256 = digest(safe.value);
      delete safe.value;
    }
    await appendFile(this.filePath, `${JSON.stringify(safe)}\n`, {
      mode: 0o600,
    });
    return safe;
  }
}

