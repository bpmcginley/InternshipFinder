// Shared raw SSE framing count. Semantic parsers retain their independent limits.
export function createSSEWireCounter(maxEventBytes, error) {
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1 || typeof error !== "function")
    throw new TypeError("Invalid SSE byte limit");
  // Count original SSE framing before decoding or acceptance. CRLF is one line
  // ending; bare CR also ends a line. A blank line resets only after its bytes
  // count, including an initial UTF-8 BOM, comments and ignored SSE fields.
  let wireEventBytes = 0,
    wireLineBytes = 0,
    wireCR = false,
    wireFirstLine = true,
    wireBom = true;
  const wireLine = () => {
    if (!wireLineBytes || (wireFirstLine && wireLineBytes === 3 && wireBom)) wireEventBytes = 0;
    wireLineBytes = 0;
    wireFirstLine = false;
  };
  const wireCount = () => {
    if (++wireEventBytes > maxEventBytes) throw error();
  };
  const scanWire = (bytes) => {
    for (const byte of bytes) {
      if (wireCR) {
        wireCR = false;
        if (byte === 10) {
          wireCount();
          wireLine();
          continue;
        }
        wireLine();
      }
      wireCount();
      if (byte === 13) wireCR = true;
      else if (byte === 10) wireLine();
      else {
        wireLineBytes++;
        if (wireFirstLine && wireLineBytes <= 3)
          wireBom = wireBom && byte === [239, 187, 191][wireLineBytes - 1];
      }
    }
  };
  return scanWire;
}
