"use strict";

// Stable local locators let small models cite rather than retype source text.
// Keep exact offsets, including separators, so numbers and negations cannot be
// changed by the quoting step.
function sourceLines(value) {
  const text = String(value || ""), rows = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    let end = newline < 0 ? text.length : newline + 1;
    if (end - start > 360) {
      end = start + 360;
      const space = text.lastIndexOf(" ", end);
      if (space > start + 180) end = space + 1;
    }
    rows.push({ id: rows.length + 1, text: text.slice(start, end), start, end });
    start = end;
  }
  return rows;
}
module.exports = { sourceLines };
