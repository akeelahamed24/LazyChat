/**
 * Tolerant JSON helpers for model-written UI input.
 *
 * Models sometimes send the `ui` argument as a JSON *string* instead of an object, wrap values in stray tags
 * like <arg_value>, or get cut off mid-object. `coerceUi` turns the recoverable cases into an object, and
 * `parsePartialJsonSync` reads a half-streamed document (used while the UI is still being written).
 */

const STRAY_TAGS = /<\/?(?:arg_key|arg_value|parameter|tool_call|ui)[^>]*>/gi;

/** Parse JSON that may be truncated: closes open strings/arrays/objects at the last point that still parses. */
export function parsePartialJsonSync(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to repair */
  }

  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  const snaps: Array<{ cut: number; closers: string }> = [];
  const closers = (s: string[]) => [...s].reverse().map((c) => (c === "{" ? "}" : "]")).join("");

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      snaps.push({ cut: i + 1, closers: closers(stack) });
    } else if (ch === ",") snaps.push({ cut: i, closers: closers(stack) });
    if (snaps.length > 12) snaps.shift();
  }

  const attempts: string[] = [];
  let tail = t;
  if (inStr) {
    if (esc) tail = tail.slice(0, -1); // dangling backslash
    attempts.push(tail + '"' + closers(stack));
  } else {
    attempts.push(t + closers(stack));
  }
  for (let k = snaps.length - 1; k >= 0; k--) attempts.push(t.slice(0, snaps[k].cut) + snaps[k].closers);
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* try the next, shorter candidate */
    }
  }
  return undefined;
}

/** The `ui` argument as an object, whether it arrived as an object or as (possibly truncated / tag-polluted) JSON text. */
export function coerceUi(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(STRAY_TAGS, "").trim();
  const parsed = parsePartialJsonSync(cleaned);
  // A doubly-encoded string ("{\"version\"...}") decodes to another string: unwrap once more.
  if (typeof parsed === "string") return parsePartialJsonSync(parsed.replace(STRAY_TAGS, ""));
  return parsed;
}
