import { detectAll } from "tinyld";

/** Detects the language of a body of text. Short strings are unreliable, so
 *  anything under 60 characters returns null rather than a guess — a wrong
 *  language claim here would produce a confident, false finding. */
export function detectLanguage(text: string): { lang: string | null; confidence: number } {
  const sample = text.slice(0, 4000).trim();
  if (sample.length < 60) return { lang: null, confidence: 0 };
  try {
    const results = detectAll(sample);
    const top = results[0];
    if (!top || top.accuracy < 0.2) return { lang: null, confidence: top?.accuracy ?? 0 };
    return { lang: top.lang, confidence: top.accuracy };
  } catch {
    return { lang: null, confidence: 0 };
  }
}

/** Normalises a declared language to its base subtag: `ro-MD` and `RO` both
 *  become `ro`, so a region suffix never reads as a mismatch. */
export function baseLang(value: string | null | undefined): string | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return base && /^[a-z]{2,3}$/.test(base) ? base : null;
}

/** Languages tinyld separates poorly. A mismatch between two of these is not
 *  reported as an error, because the detector is the unreliable party. */
const CONFUSABLE: string[][] = [
  ["ro", "mo"],
  ["hr", "sr", "bs", "sh"],
  ["cs", "sk"],
  ["id", "ms"],
  ["nb", "no", "nn", "da"],
  ["hi", "mr", "ne"],
];

export function confusable(a: string, b: string): boolean {
  return CONFUSABLE.some((set) => set.includes(a) && set.includes(b));
}
