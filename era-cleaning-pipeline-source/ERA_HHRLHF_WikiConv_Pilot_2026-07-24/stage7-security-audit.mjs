import crypto from "node:crypto";

const SIGNALS = [
  {
    type: "prompt_override_instruction",
    severity: "medium",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:previous|prior|above|system|developer)\b.{0,40}\b(?:instruction|prompt|message|rule)s?\b/giu,
  },
  {
    type: "system_prompt_exfiltration",
    severity: "high",
    pattern:
      /\b(?:reveal|print|show|repeat|leak|extract|exfiltrat\w*)\b.{0,60}\b(?:system|developer|hidden)\s+(?:prompt|message|instruction)s?\b/giu,
  },
  {
    type: "poisoning_or_backdoor_language",
    severity: "medium",
    pattern:
      /\b(?:poison(?:ing|ed)?\s+(?:the\s+)?(?:training\s+)?data|training[- ]data\s+poisoning|backdoor\s+(?:trigger|model|training)|sleeper\s+agent|trigger\s+token)\b/giu,
  },
  {
    type: "malware_intent_language",
    severity: "high",
    pattern:
      /\b(?:ransomware|keylogger|credential\s+stealer|password\s+stealer|rootkit|botnet|reverse\s+shell|cryptominer|crypto[- ]?miner|browser\s+cookie\s+stealer)\b/giu,
  },
  {
    type: "dangerous_download_execute",
    severity: "critical",
    pattern:
      /\b(?:curl|wget)\b[^\n]{0,240}\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/giu,
  },
  {
    type: "encoded_powershell",
    severity: "critical",
    pattern:
      /\bpowershell(?:\.exe)?\b[^\n]{0,160}\s-(?:enc|encodedcommand)\b/giu,
  },
  {
    type: "reverse_shell_command",
    severity: "critical",
    pattern:
      /(?:\/dev\/tcp\/|\bnc\b[^\n]{0,100}\s-e\s|\bbash\s+-i\b[^\n]{0,100}>&)/giu,
  },
  {
    type: "destructive_system_command",
    severity: "critical",
    pattern:
      /(?:\brm\s+-rf\s+\/(?:\s|$)|\bformat\s+[a-z]:\s*\/q\b|\bdel\s+\/s\s+\/q\s+[a-z]:\\)/giu,
  },
];

const LONG_BASE64 =
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/])/gu;
const LONG_HEX = /(?<![0-9a-f])[0-9a-f]{240,}(?![0-9a-f])/giu;
const SAFE_REFUSAL =
  /(?:\b(?:i\s+can(?:not|'t)|i\s+won't|unable\s+to|cannot\s+assist|can't\s+help)\b.{0,100}\b(?:malware|harm|steal|credential|attack|exploit|ransomware|keylogger|reverse\s+shell|unauthorized)\b|\b(?:cannot|can't|won't|do\s+not)\b.{0,80}\b(?:provide|reveal|print|have)\b.{0,80}\b(?:system|developer|hidden)\s+(?:prompt|instruction)s?\b)/giu;
const EDUCATIONAL_CONTEXT =
  /\b(?:defensive|detection|detect|prevention|prevent|mitigation|mitigate|analysis|analyze|sandbox|incident\s+response|authorized|ethical|security\s+training|educational)\b/giu;

export function securitySignals(text) {
  if (typeof text !== "string") {
    throw new TypeError("Security audit requires string text.");
  }
  const findings = [];
  for (const signal of SIGNALS) {
    signal.pattern.lastIndex = 0;
    const count = [...text.matchAll(signal.pattern)].length;
    if (count) findings.push({ type: signal.type, severity: signal.severity, count });
  }
  LONG_BASE64.lastIndex = 0;
  const base64Count = [...text.matchAll(LONG_BASE64)].filter(({ 0: value }) => {
    const letters = (value.match(/[A-Za-z]/gu) ?? []).length;
    return letters >= 20 && letters / value.length >= 0.15;
  }).length;
  if (base64Count) {
    findings.push({
      type: "long_base64_blob",
      severity: "high",
      count: base64Count,
    });
  }
  LONG_HEX.lastIndex = 0;
  const hexCount = [...text.matchAll(LONG_HEX)].filter(({ 0: value }) => {
    const letters = (value.match(/[a-f]/giu) ?? []).length;
    return letters >= 20 && new Set(value.toLowerCase()).size >= 8;
  }).length;
  if (hexCount) {
    findings.push({ type: "long_hex_blob", severity: "high", count: hexCount });
  }
  return findings;
}

export function classifySecurityTurn(prompt, response) {
  const promptFindings = securitySignals(prompt);
  const responseFindings = securitySignals(response);
  SAFE_REFUSAL.lastIndex = 0;
  const safeRefusal = SAFE_REFUSAL.test(response);
  EDUCATIONAL_CONTEXT.lastIndex = 0;
  const educationalContext =
    EDUCATIONAL_CONTEXT.test(prompt) || EDUCATIONAL_CONTEXT.test(response);
  const responseHasCritical = responseFindings.some(
    (finding) => finding.severity === "critical",
  );
  const responseHasPayload = responseFindings.some((finding) =>
    ["long_base64_blob", "long_hex_blob"].includes(finding.type),
  );
  const promptHasInjection = promptFindings.some((finding) =>
    ["prompt_override_instruction", "system_prompt_exfiltration"].includes(
      finding.type,
    ),
  );

  let disposition = "no_signal";
  if (safeRefusal) disposition = "likely_safe_refusal_review";
  else if (responseHasCritical || responseHasPayload || promptHasInjection) {
    disposition = "high_priority_security_review";
  } else if (promptFindings.length || responseFindings.length) {
    disposition = educationalContext
      ? "educational_or_defensive_review"
      : "context_review";
  }
  return {
    promptFindings,
    responseFindings,
    safeRefusal,
    educationalContext,
    disposition,
    automaticAction: "none_audit_only",
  };
}

export function redactSecurityPreview(text, maximum = 320) {
  let output = text
    .replace(LONG_BASE64, (value) => {
      const letters = (value.match(/[A-Za-z]/gu) ?? []).length;
      return letters >= 20 && letters / value.length >= 0.15
        ? "[LONG_BASE64_BLOB]"
        : value;
    })
    .replace(LONG_HEX, (value) => {
      const letters = (value.match(/[a-f]/giu) ?? []).length;
      return letters >= 20 && new Set(value.toLowerCase()).size >= 8
        ? "[LONG_HEX_BLOB]"
        : value;
    })
    .replace(/https?:\/\/\S+/giu, "[URL]")
    .replace(/\s+/gu, " ")
    .trim();
  if (output.length > maximum) output = `${output.slice(0, maximum)}…`;
  return output;
}

export function fingerprintSecurityEntry(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
