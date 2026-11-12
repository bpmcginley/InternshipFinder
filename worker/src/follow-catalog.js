// Dormant parser: the caller supplies trusted digests, prior public keys and explicit bounds.
const encoder = new TextEncoder();
const kinds = ["companies", "fields", "states"];
const digestShape = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const shape = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).join(",") === names.join(",");
const text = (value, bytes) =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value) &&
  encoder.encode(value).byteLength <= bytes;
const key = (value, kind) =>
  text(value, 200) &&
  (kind !== "fields" || /^[a-z_]{2,32}$/.test(value)) &&
  (kind !== "states" || /^[A-Z]{2}$/.test(value));
export { key as validFollowCatalogKey };
const invalid = () => {
  throw new Error("Follow catalog unavailable");
};

export function copyFollowCatalogPrevious(previousValid, maxKeys) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0 || !shape(previousValid, kinds))
    return invalid();
  const previous = {};
  for (const kind of kinds) {
    const values = previousValid[kind];
    if (!(values instanceof Set) || values.size > maxKeys || [...values].some((v) => !key(v, kind)))
      return invalid();
    previous[kind] = new Set(values);
  }
  return previous;
}

export async function parseFollowCatalog(input, options) {
  try {
    const { maxBytes, maxKeys, sourceSha256, catalogSha256, previousValid } = options;
    if (
      ![maxBytes, maxKeys].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !digestShape(sourceSha256) ||
      !digestShape(catalogSha256) ||
      !(input instanceof Uint8Array) ||
      !input.byteLength ||
      input.byteLength > maxBytes ||
      !shape(previousValid, kinds)
    )
      return invalid();
    // Capture caller-owned Buffer/Uint8Array and prior Sets before the hashing await.
    const bytes = new Uint8Array(input);
    const previous = copyFollowCatalogPrevious(previousValid, maxKeys);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== catalogSha256) return invalid();
    const wire = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(wire);
    if (
      !shape(value, ["version", "source_sha256", "signup", "valid", "aliases"]) ||
      value.version !== 1 ||
      value.source_sha256 !== sourceSha256 ||
      !shape(value.signup, kinds) ||
      !shape(value.valid, kinds)
    )
      return invalid();
    const result = { signup: {}, valid: {}, aliases: new Map() };
    for (const group of ["signup", "valid"])
      for (const kind of kinds) {
        const values = value[group][kind];
        if (
          !Array.isArray(values) ||
          values.length > maxKeys ||
          values.some((v, i) => !key(v, kind) || (i > 0 && values[i - 1] >= v))
        )
          return invalid();
        result[group][kind] = new Set(values);
      }
    if (!result.signup.fields.size || !result.signup.states.size) return invalid();
    for (const kind of kinds)
      for (const member of [...result.signup[kind], ...previous[kind]])
        if (!result.valid[kind].has(member)) return invalid();
    if (!Array.isArray(value.aliases) || value.aliases.length > maxKeys) return invalid();
    for (const [index, pair] of value.aliases.entries()) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !text(pair[0], 800) ||
        pair[0].length > 200 ||
        !result.signup.companies.has(pair[1]) ||
        (index > 0 && value.aliases[index - 1][0] >= pair[0])
      )
        return invalid();
      result.aliases.set(pair[0], pair[1]);
    }
    if (new Set(result.aliases.values()).size !== result.signup.companies.size) return invalid();
    // Compare encoded bytes too: TextDecoder consumes a BOM; JSON.parse accepts duplicate keys.
    const canonical = encoder.encode(JSON.stringify(value));
    if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i]))
      return invalid();
    return result;
  } catch {
    return invalid();
  }
}
