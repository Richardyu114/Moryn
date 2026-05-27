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

export function redactSensitiveContent(text: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "[REDACTED_SECRET]"), text);
}
