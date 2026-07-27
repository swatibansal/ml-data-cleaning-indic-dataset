import crypto from "node:crypto";

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function conversationText(interactions) {
  if (!Array.isArray(interactions)) {
    throw new TypeError("Stage 5 requires an interactions array.");
  }
  return interactions
    .map((turn) => {
      if (
        !Array.isArray(turn) ||
        turn.length !== 2 ||
        typeof turn[0] !== "string" ||
        typeof turn[1] !== "string"
      ) {
        throw new TypeError("Every interaction must be a prompt-response string pair.");
      }
      return `${turn[0]}\u241e${turn[1]}`;
    })
    .join("\u241d");
}

export function normalizeForSimilarity(text) {
  if (typeof text !== "string") {
    throw new TypeError("Stage 5 similarity normalization requires string text.");
  }
  return text.normalize("NFC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function fnv1a64(text) {
  let hash = FNV_OFFSET;
  for (const character of text) {
    hash ^= BigInt(character.codePointAt(0));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

export function characterShingles(text, width = 5, maximum = 5000) {
  const points = [...normalizeForSimilarity(text)];
  if (points.length < width) return new Set(points.length ? [points.join("")] : []);
  const total = points.length - width + 1;
  const stride = Math.max(1, Math.ceil(total / maximum));
  const shingles = new Set();
  for (let index = 0; index < total; index += stride) {
    shingles.add(points.slice(index, index + width).join(""));
  }
  if ((total - 1) % stride !== 0) {
    shingles.add(points.slice(total - 1, total - 1 + width).join(""));
  }
  return shingles;
}

export function simhash64(shingles) {
  const weights = new Int32Array(64);
  for (const shingle of shingles) {
    const hash = fnv1a64(shingle);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] += (hash & (1n << BigInt(bit))) === 0n ? -1 : 1;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (weights[bit] >= 0) result |= 1n << BigInt(bit);
  }
  return result;
}

export function hammingDistance64(left, right) {
  let difference = left ^ right;
  let count = 0;
  while (difference) {
    difference &= difference - 1n;
    count += 1;
  }
  return count;
}

export function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  for (const value of smaller) {
    if (larger.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function isNearDuplicate(left, right, options = {}) {
  const minimumCodePoints = options.minimumCodePoints ?? 40;
  const minimumLengthRatio = options.minimumLengthRatio ?? 0.8;
  const maximumHammingDistance = options.maximumHammingDistance ?? 3;
  const minimumJaccard = options.minimumJaccard ?? 0.85;
  if (
    left.normalizedLength < minimumCodePoints ||
    right.normalizedLength < minimumCodePoints
  ) {
    return { match: false, reason: "too_short" };
  }
  const lengthRatio =
    Math.min(left.normalizedLength, right.normalizedLength) /
    Math.max(left.normalizedLength, right.normalizedLength);
  if (lengthRatio < minimumLengthRatio) {
    return { match: false, reason: "length_ratio", lengthRatio };
  }
  const hamming = hammingDistance64(left.simhash, right.simhash);
  if (hamming > maximumHammingDistance) {
    return { match: false, reason: "simhash", lengthRatio, hamming };
  }
  const similarity = jaccard(left.shingles, right.shingles);
  return {
    match: similarity >= minimumJaccard,
    reason: similarity >= minimumJaccard ? "near_duplicate" : "jaccard",
    lengthRatio,
    hamming,
    jaccard: similarity,
  };
}

export function bandKeys(simhash, bandCount = 4, bitsPerBand = 16) {
  const mask = (1n << BigInt(bitsPerBand)) - 1n;
  return Array.from({ length: bandCount }, (_, band) => {
    const value = (simhash >> BigInt(band * bitsPerBand)) & mask;
    return `${band}:${value.toString(16).padStart(bitsPerBand / 4, "0")}`;
  });
}
