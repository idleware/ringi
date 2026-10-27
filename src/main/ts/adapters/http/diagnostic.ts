// A response may echo its Authorization header. Redact before shortening and show controls as literal escapes.
export const diagnostic = (value: string, secret: string): string => value.split(secret).join('[redacted]')
  .replace(/\b(Bearer|token|Basic)\s+[^\s"'<>]+/gi, '$1 [redacted]')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    c => c.charCodeAt(0) < 256 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}` : `\\u${c.charCodeAt(0).toString(16)}`)
