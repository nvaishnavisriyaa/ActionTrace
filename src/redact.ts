import type { Target } from "./protocol.js";

const SENSITIVE_QUERY_KEY = /(token|key|secret|passw|pwd|auth|session|sid|code|signature|sig|jwt|bearer|credential|otp)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_DIGITS = /\b\d[\d\s-]{6,}\d\b/g;
const TOKENISH_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{24,}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Strip control / bidi characters and bound length. Page-provided text is untrusted data. */
export function cleanText(input: unknown, max = 80): string {
  if (typeof input !== "string") return "";
  const s = input.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Redact personal-looking content from labels. */
export function redactLabel(input: unknown, max = 80): string {
  return cleanText(input, max * 2).replace(EMAIL, "[email]").replace(LONG_DIGITS, "[number]").slice(0, max);
}

/**
 * Remove credentials, fragments, sensitive query values and token-looking path segments.
 * Returns "[invalid-url]" for anything that is not an http(s)/file/about URL.
 */
export function redactUrl(input: unknown): string {
  if (typeof input !== "string") return "";
  if (input === "about:blank") return input;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return "[invalid-url]";
  }
  if (!["http:", "https:", "file:"].includes(u.protocol)) return `${u.protocol}[redacted]`;
  u.username = "";
  u.password = "";
  u.hash = "";
  u.pathname = u.pathname
    .split("/")
    .map((seg) => (TOKENISH_SEGMENT.test(seg) ? ":redacted" : seg))
    .join("/");
  const keys = [...u.searchParams.keys()];
  for (const k of keys) {
    if (SENSITIVE_QUERY_KEY.test(k)) u.searchParams.set(k, "[redacted]");
  }
  const out = u.toString();
  return out.length > 300 ? out.slice(0, 299) + "…" : out;
}

export function sanitizeTarget(t: Target | undefined): Target | undefined {
  if (!t || typeof t !== "object") return undefined;
  const out: Target = {};
  if (typeof t.role === "string") out.role = cleanText(t.role, 32);
  if (typeof t.tag === "string") out.tag = cleanText(t.tag, 24).toLowerCase();
  if (typeof t.inputType === "string") out.inputType = cleanText(t.inputType, 24).toLowerCase();
  if (t.sensitive) out.sensitive = true;
  const label = redactLabel(t.label);
  if (label) out.label = label;
  return Object.keys(out).length ? out : undefined;
}

export function isSensitiveInputType(type: string | undefined): boolean {
  return type === "password";
}
