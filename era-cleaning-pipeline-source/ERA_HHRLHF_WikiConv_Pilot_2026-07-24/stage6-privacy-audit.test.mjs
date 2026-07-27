import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzePrivacy,
  redactFindings,
  validAadhaarChecksum,
  validGstinChecksum,
} from "./stage6-privacy-audit.mjs";

test("detects and redacts email without retaining its value", () => {
  const text = "Contact riya.sharma@example.com today.";
  const findings = analyzePrivacy(text);
  assert.equal(findings[0].type, "email");
  const redacted = redactFindings(text, findings);
  assert.equal(redacted.includes("riya.sharma"), false);
  assert.match(redacted, /\[EMAIL_1\]/u);
});

test("detects a plausible phone candidate", () => {
  const findings = analyzePrivacy("Call +1 (919) 555-0123.");
  assert.equal(findings.some((item) => item.type === "phone_candidate"), true);
});

test("detects a Luhn-valid payment card candidate", () => {
  const findings = analyzePrivacy("Number: 4111 1111 1111 1111");
  assert.equal(
    findings.some((item) => item.type === "payment_card_candidate"),
    true,
  );
});

test("separates a secret placeholder from a plausible secret", () => {
  assert.equal(
    analyzePrivacy('API_KEY="YOUR_API_KEY_HERE"')[0].type,
    "secret_placeholder",
  );
  assert.equal(
    analyzePrivacy("api_key=sk_live_AbC123456789")[0].type,
    "generic_secret_candidate",
  );
});

test("detects high-confidence credential formats", () => {
  assert.equal(
    analyzePrivacy("AKIAIOSFODNN7EXAMPLE").some(
      (item) => item.type === "aws_access_key",
    ),
    true,
  );
  assert.equal(
    analyzePrivacy("-----BEGIN PRIVATE KEY-----").some(
      (item) => item.type === "private_key_header",
    ),
    true,
  );
});

test("rejects invalid IPv4 candidates", () => {
  assert.equal(
    analyzePrivacy("999.999.999.999").some(
      (item) => item.type === "ipv4_address",
    ),
    false,
  );
});

test("does not mutate source text", () => {
  const text = "Email a@example.com";
  const before = text;
  analyzePrivacy(text);
  assert.equal(text, before);
});

test("validates Aadhaar with Verhoeff and rejects a format-only example", () => {
  assert.equal(validAadhaarChecksum("2345 6789 0123"), false);
  assert.equal(validAadhaarChecksum("2123 4567 8901"), true);
  const valid = analyzePrivacy("Aadhaar: 2123 4567 8901");
  assert.equal(
    valid.some((item) => item.type === "indian_aadhaar_valid_checksum"),
    true,
  );
  const contextual = analyzePrivacy("Aadhaar number: 2345 6789 0123");
  assert.equal(
    contextual.some(
      (item) => item.type === "indian_aadhaar_context_candidate",
    ),
    true,
  );
});

test("validates GSTIN checksum and keeps format-only candidates distinct", () => {
  assert.equal(validGstinChecksum("27AAPFU0939F1ZV"), true);
  assert.equal(validGstinChecksum("27AAPFU0939F1ZA"), false);
  assert.equal(
    analyzePrivacy("GSTIN 27AAPFU0939F1ZV").some(
      (item) => item.type === "indian_gstin_valid_checksum",
    ),
    true,
  );
});

test("detects India-specific financial identifiers", () => {
  const findings = analyzePrivacy(
    "IFSC SBIN0001234; UPI ID: merchant.name@upi; account number 12345678901",
  );
  assert.equal(
    findings.some((item) => item.type === "indian_ifsc_candidate"),
    true,
  );
  assert.equal(
    findings.some((item) => item.type === "indian_upi_context_candidate"),
    true,
  );
  assert.equal(
    findings.some(
      (item) => item.type === "indian_bank_account_context_candidate",
    ),
    true,
  );
});

test("requires context for passport and EPIC-shaped values", () => {
  assert.equal(
    analyzePrivacy("Reference A1234567").some(
      (item) => item.type === "indian_passport_context_candidate",
    ),
    false,
  );
  assert.equal(
    analyzePrivacy("Passport number A1234567").some(
      (item) => item.type === "indian_passport_context_candidate",
    ),
    true,
  );
  assert.equal(
    analyzePrivacy("Voter ID ABC1234567").some(
      (item) => item.type === "indian_epic_context_candidate",
    ),
    true,
  );
});

test("detects the Parivahan-style driving licence format", () => {
  assert.equal(
    analyzePrivacy("DL-1420110012345").some(
      (item) => item.type === "indian_driving_licence_candidate",
    ),
    true,
  );
});
