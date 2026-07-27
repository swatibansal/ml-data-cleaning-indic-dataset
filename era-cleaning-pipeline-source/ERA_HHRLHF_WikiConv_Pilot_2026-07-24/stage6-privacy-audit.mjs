import crypto from "node:crypto";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?\d[\d ().-]{6,}\d)(?!\d)/gu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gu;
const AADHAAR = /(?<!\d)([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/gu;
const GSTIN = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/gu;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/gu;
const INDIAN_MOBILE = /(?<!\d)(?:\+91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)/gu;
const DRIVING_LICENCE =
  /\b[A-Z]{2}[- ]?[0-9]{2}[ -]?(?:19|20)[0-9]{2}[ -]?[0-9]{7}\b/gu;
const PASSPORT = /\b[A-Z][0-9]{7}\b/gu;
const EPIC = /\b[A-Z]{3}[0-9]{7}\b/gu;
const UPI_ID = /\b[A-Z0-9._-]{2,256}@[A-Z][A-Z0-9.-]{1,63}\b/giu;
const ACCOUNT_NUMBER = /(?<!\d)\d{9,18}(?!\d)/gu;
const LONG_DIGITS = /(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/gu;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu;
const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{8,})["']?/giu;

const PLACEHOLDER =
  /^(?:your|replace|example|sample|dummy|test|fake|changeme|xxxxx|<|\{|\[)/iu;

const INDIA_CONTEXT = {
  aadhaar:
    /\b(?:aadhaar|aadhar|uidai|आधार|ಆಧಾರ್|ఆధార్|ஆதார்|ആധാർ|আধার|ଆଧାର)\b/iu,
  passport:
    /\b(?:passport|पासपोर्ट|ಪಾಸ್‌ಪೋರ್ಟ್|పాస్‌పోర్ట్|பாஸ்போர்ட்|പാസ്‌പോർട്ട്|পাসপোর্ট)\b/iu,
  epic:
    /\b(?:epic|voter(?:'s)?\s*(?:id|card)|elector(?:al)?\s*(?:id|card)|मतदाता|வாக்காளர்|ఓటరు|ಮತದಾರ|വോട്ടർ|ভোটার)\b/iu,
  upi:
    /\b(?:upi|vpa|virtual payment address|bhim|यूपीआई|ಯುಪಿಐ|యూపీఐ|யுபிஐ|യുപിഐ|ইউপিআই)\b/iu,
  account:
    /\b(?:bank\s*)?(?:account|a\/c)(?:\s*(?:number|no\.?))?|खाता|கணக்கு|ఖాతా|ಖಾತೆ|അക്കൗണ്ട്|অ্যাকাউন্ট\b/iu,
  ration:
    /\b(?:ration\s*card|राशन\s*कार्ड|ரேஷன்\s*கார்டு|రేషన్\s*కార్డు|ಪಡಿತರ\s*ಚೀಟಿ|റേഷൻ\s*കാർഡ്|রেশন\s*কার্ড)\b/iu,
};

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function sha256Prefix(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function validIpv4(value) {
  return value.split(".").every((part) => Number(part) <= 255);
}

function luhn(value) {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function digitCount(value) {
  return (value.match(/\d/gu) ?? []).length;
}

export function validAadhaarChecksum(value) {
  const digits = value.replace(/\D/gu, "");
  if (!/^[2-9]\d{11}$/u.test(digits)) return false;
  let checksum = 0;
  [...digits]
    .reverse()
    .forEach((digit, index) => {
      checksum = VERHOEFF_D[checksum][VERHOEFF_P[index % 8][Number(digit)]];
    });
  return checksum === 0;
}

export function validGstinChecksum(value) {
  const normalized = value.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/u.test(normalized)) {
    return false;
  }
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let factor = 2;
  let sum = 0;
  for (let index = normalized.length - 2; index >= 0; index -= 1) {
    const product = alphabet.indexOf(normalized[index]) * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  const checkCode = (36 - (sum % 36)) % 36;
  return normalized.at(-1) === alphabet[checkCode];
}

function hasNearbyContext(text, start, end, pattern, radius = 48) {
  const context = text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
  return pattern.test(context);
}

function collectContextual(text, pattern, type, contextPattern, predicate = () => true) {
  pattern.lastIndex = 0;
  const findings = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!predicate(match[0], match)) continue;
    if (!hasNearbyContext(text, start, end, contextPattern)) continue;
    findings.push({
      type,
      start,
      end,
      fingerprint: sha256Prefix(match[0]),
    });
  }
  return findings;
}

function collect(text, pattern, type, predicate = () => true) {
  pattern.lastIndex = 0;
  const findings = [];
  for (const match of text.matchAll(pattern)) {
    if (!predicate(match[0], match)) continue;
    findings.push({
      type,
      start: match.index,
      end: match.index + match[0].length,
      fingerprint: sha256Prefix(match[0]),
    });
  }
  return findings;
}

export function analyzePrivacy(text) {
  if (typeof text !== "string") {
    throw new TypeError("Stage 6 privacy analysis requires string text.");
  }
  const findings = [
    ...collect(text, EMAIL, "email"),
    ...collect(
      text,
      PHONE,
      "phone_candidate",
      (value) => digitCount(value) >= 8 && digitCount(value) <= 15,
    ),
    ...collect(text, IPV4, "ipv4_address", validIpv4),
    ...collect(text, PAN, "indian_pan_candidate"),
    ...collect(
      text,
      AADHAAR,
      "indian_aadhaar_valid_checksum",
      (value) => validAadhaarChecksum(value),
    ),
    ...collectContextual(
      text,
      AADHAAR,
      "indian_aadhaar_context_candidate",
      INDIA_CONTEXT.aadhaar,
      (value) => !validAadhaarChecksum(value),
    ),
    ...collect(
      text,
      GSTIN,
      "indian_gstin_valid_checksum",
      (value) => validGstinChecksum(value),
    ),
    ...collect(
      text,
      GSTIN,
      "indian_gstin_format_candidate",
      (value) => !validGstinChecksum(value),
    ),
    ...collect(text, IFSC, "indian_ifsc_candidate"),
    ...collect(text, INDIAN_MOBILE, "indian_mobile_candidate"),
    ...collect(text, DRIVING_LICENCE, "indian_driving_licence_candidate"),
    ...collectContextual(
      text,
      PASSPORT,
      "indian_passport_context_candidate",
      INDIA_CONTEXT.passport,
    ),
    ...collectContextual(
      text,
      EPIC,
      "indian_epic_context_candidate",
      INDIA_CONTEXT.epic,
    ),
    ...collectContextual(
      text,
      UPI_ID,
      "indian_upi_context_candidate",
      INDIA_CONTEXT.upi,
    ),
    ...collectContextual(
      text,
      ACCOUNT_NUMBER,
      "indian_bank_account_context_candidate",
      INDIA_CONTEXT.account,
    ),
    ...collectContextual(
      text,
      /(?<![A-Z0-9])[A-Z0-9/-]{6,24}(?![A-Z0-9])/giu,
      "indian_ration_card_context_candidate",
      INDIA_CONTEXT.ration,
      (value) => /\d/u.test(value),
    ),
    ...collect(text, AWS_ACCESS_KEY, "aws_access_key"),
    ...collect(text, JWT, "jwt_candidate"),
    ...collect(text, PRIVATE_KEY, "private_key_header"),
  ];

  LONG_DIGITS.lastIndex = 0;
  for (const match of text.matchAll(LONG_DIGITS)) {
    const digits = match[0].replace(/\D/gu, "");
    if (luhn(match[0])) {
      findings.push({
        type: "payment_card_candidate",
        start: match.index,
        end: match.index + match[0].length,
        fingerprint: sha256Prefix(match[0]),
      });
    } else if (digits.length === 12) {
      findings.push({
        type: "twelve_digit_id_candidate",
        start: match.index,
        end: match.index + match[0].length,
        fingerprint: sha256Prefix(match[0]),
      });
    }
  }

  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    findings.push({
      type: PLACEHOLDER.test(match[2])
        ? "secret_placeholder"
        : "generic_secret_candidate",
      start: match.index,
      end: match.index + match[0].length,
      fingerprint: sha256Prefix(match[0]),
    });
  }

  findings.sort((left, right) => left.start - right.start || left.end - right.end);
  return findings;
}

export function redactFindings(text, findings) {
  if (typeof text !== "string" || !Array.isArray(findings)) {
    throw new TypeError("Stage 6 redaction requires text and findings.");
  }
  const nonOverlapping = [];
  for (const finding of [...findings].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    const previous = nonOverlapping.at(-1);
    if (previous && finding.start < previous.end) continue;
    nonOverlapping.push(finding);
  }
  let output = "";
  let cursor = 0;
  const counters = new Map();
  for (const finding of nonOverlapping) {
    const count = (counters.get(finding.type) ?? 0) + 1;
    counters.set(finding.type, count);
    output += text.slice(cursor, finding.start);
    output += `[${finding.type.toUpperCase()}_${count}]`;
    cursor = finding.end;
  }
  return output + text.slice(cursor);
}
