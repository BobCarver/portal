/**
 * A tiny HTML template tag: every interpolated value is escaped unless it is
 * itself `Html` (another template, or `raw()`). Arrays are joined.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Date) return escape(v.toISOString());
  return escape(String(v));
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Html(out);
}

/** Trusted markup, inserted as is. */
export const raw = (s: string) => new Html(s);
