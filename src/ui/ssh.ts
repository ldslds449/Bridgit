export type SshDocument = { path: string; content: string | null; backup: boolean };
export type HostEntry = { name: string; source: string; line: number };
export type ResolvedHost = { host: string; port: number; user: string; identity_files: string[] };
export const emptyHost = { Host: "", HostName: "", User: "", Port: "22", IdentityFile: "" };
export type HostForm = typeof emptyHost;

function directive(line: string) {
  return line.match(/^(\s*)(\w+)(?:\s*=\s*|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^#\r\n]*?)(\s*(?:#.*)?)(\r?\n)?$/);
}

export function simpleHost(text: string): HostForm | null {
  const form = { ...emptyHost, Port: "" };
  const seen = new Set<string>();
  for (const line of text.split(/(?<=\n)/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = directive(line);
    const key = Object.keys(form).find(k => k.toLowerCase() === match?.[2].toLowerCase()) as keyof HostForm | undefined;
    if (!match || !key || seen.has(key)) return null;
    const value = match[3].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key === "Host" && !/^[\w.-]+$/.test(value)) return null;
    if (key !== "IdentityFile" && /\s/.test(value)) return null;
    form[key] = value; seen.add(key);
  }
  return seen.has("Host") ? form : null;
}

export function updateSimpleHost(text: string, form: HostForm): string {
  const previous = simpleHost(text);
  if (!previous) throw new Error("此區塊需要使用原文編輯");
  const seen = new Set<string>();
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let updated = text.split(/(?<=\n)/).map(line => {
    const match = directive(line);
    const key = Object.keys(form).find(k => k.toLowerCase() === match?.[2].toLowerCase()) as keyof HostForm | undefined;
    if (!match || !key) return line;
    seen.add(key);
    if (previous[key] === form[key]) return line;
    if (!form[key]) return match[4].trim() ? `${match[1]}${match[4].trim()}${match[5] ?? ""}` : "";
    const value = /\s/.test(form[key]) ? `"${form[key]}"` : form[key];
    return `${match[1]}${match[2]} ${value}${match[4]}${match[5] ?? ""}`;
  }).join("");
  for (const key of Object.keys(form) as (keyof HostForm)[]) {
    if (!seen.has(key) && form[key]) {
      if (updated && !updated.endsWith("\n")) updated += newline;
      updated += `    ${key} ${/\s/.test(form[key]) ? `"${form[key]}"` : form[key]}${newline}`;
    }
  }
  return updated;
}

export function hostBlocks(text: string) {
  const lines = text.split(/(?<=\n)/);
  const blocks: { name: string; start: number; end: number; text: string }[] = [];
  let offset = 0;
  for (const line of lines) {
    const match = line.replace(/^\uFEFF/, "").match(/^\s*(Host|Match)(?:\s+|\s*=\s*)(.*?)(?:\r?\n)?$/i);
    if (match) {
      if (blocks.length) blocks[blocks.length - 1].end = offset;
      blocks.push({ name: `${match[1]} ${match[2]}`, start: offset, end: text.length, text: "" });
    }
    offset += line.length;
  }
  return blocks.map(block => ({ ...block, text: text.slice(block.start, block.end) }));
}

export function errorText(error: unknown) { return String(error); }
