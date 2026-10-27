// A character count is not a token count, and the memory budget was counted in
// characters (C19). One Chinese character is roughly one token; four Latin
// characters are roughly one. So a 1500-character budget is ~1500 tokens of
// Chinese but ~375 of English — the same knob, a fourfold difference in what it
// actually buys, on a number that was being read as "how much context".
//
// This is an estimate, not a tokenizer: shipping a real one would mean a
// dependency and a BPE table for every model anyone might route to. The estimate
// is deliberately conservative (it rounds up) and is only used to decide when to
// stop adding text, never to bill anything.
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // CJK ideographs, kana, hangul: one token per character is the safe side.
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}
