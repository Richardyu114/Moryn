export const REDACTED_SECRET = "[REDACTED_SECRET]";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /api[_-]?key\s*=\s*["']?[A-Za-z0-9_-]{10,}/i,
  /authorization\s*[:=]\s*(?:bearer|basic|token)\s+[^"'\s]{8,}/i,
  /(?:^|\n)\s*cookie\s*:\s*[^=\n;]{1,128}=[^;\n]{8,}/i,
  /(?:^|\n)\s*[A-Z0-9_]*(?:DATABASE_URL|REDIS_URL|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,}/i,
  /password\s*=\s*["']?[^"'\s]{8,}/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/
];

export interface SensitiveCheckResult {
  sensitive: boolean;
  reason?: string;
}

export function detectSensitiveContent(text: string): SensitiveCheckResult {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return { sensitive: true, reason: pattern.source };
    }
  }
  return { sensitive: false };
}

function collectSensitiveScanFragments(value: unknown, keyPath?: string): string[] {
  if (typeof value === "string") {
    if (value === REDACTED_SECRET) return [value];
    if (!keyPath) return [value];
    const leafKey = keyPath.split(".").at(-1);
    const keyedValues = value.split(/\r?\n/).flatMap((line) => [
      `${keyPath}=${line}`,
      ...(leafKey && leafKey !== keyPath ? [`${leafKey}=${line}`] : [])
    ]);
    return [value, ...keyedValues];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSensitiveScanFragments(item, keyPath ? `${keyPath}.${index}` : String(index)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      return collectSensitiveScanFragments(nested, nextPath);
    });
  }
  return [];
}

export function sensitiveScanText(value: unknown): string {
  return [
    ...collectSensitiveScanFragments(value),
    JSON.stringify(value) ?? ""
  ].join("\n");
}

export function redactSensitiveContent(text: string): string {
  let redacted = text;
  let previous: string;
  do {
    previous = redacted;
    redacted = SECRET_PATTERNS.reduce((next, pattern) => next.replace(pattern, REDACTED_SECRET), redacted);
  } while (redacted !== previous);
  return redacted;
}
