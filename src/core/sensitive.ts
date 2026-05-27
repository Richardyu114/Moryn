const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /api[_-]?key\s*=\s*["']?[A-Za-z0-9_-]{10,}/i,
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
