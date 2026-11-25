import { Fragment, type ReactNode } from "react";
import { withKeys } from "../keys.ts";

/**
 * A small Markdown reader for scripts, notes and what the agent says. It builds React elements and never sets
 * HTML, so text the agent or a fetched page wrote can only ever show as text. Links open only for http(s).
 */

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const token = m[0];
    if (m[1]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    else if (m[5]) {
      const label = token.slice(1, token.indexOf("]("));
      out.push(<a key={k} href={m[6]} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else if (m[7]) out.push(<a key={k} href={token} target="_blank" rel="noopener noreferrer">{token}</a>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; text: string; lang: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "table"; head: string[]; rows: string[][] };

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function parse(src: string): Block[] {
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      blocks.push({ t: "code", text: body.join("\n"), lang: fence[1] ?? "" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: body.join(" ") });
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const l = lines[i]!;
        if (bullet.test(l)) items.push(l.replace(bullet, ""));
        else if (items.length) items[items.length - 1] += ` ${l.trim()}`;
        i += 1;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s|^\s*```|^\s*>/.test(lines[i]!) && !(body.length && bullet.test(lines[i]!))) body.push(lines[i++]!.trim());
    blocks.push({ t: "p", text: body.join(" ") });
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ""}`}>
      {parse(text).map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case "h": {
            const Tag = `h${Math.min(6, b.level + 1)}` as "h2";
            return <Tag key={k}>{inline(b.text, k)}</Tag>;
          }
          case "p":
            return <p key={k}>{inline(b.text, k)}</p>;
          case "code":
            return (
              <pre key={k} className="code">
                <code>{b.text}</code>
              </pre>
            );
          case "ul":
            return <ul key={k}>{withKeys(b.items, (it) => it).map(({ key, item }) => <li key={key}>{inline(item, `${k}-${key}`)}</li>)}</ul>;
          case "ol":
            return <ol key={k}>{withKeys(b.items, (it) => it).map(({ key, item }) => <li key={key}>{inline(item, `${k}-${key}`)}</li>)}</ol>;
          case "quote":
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
          case "hr":
            return <hr key={k} />;
          case "table":
            return (
              <div key={k} className="table-wrap">
                <table>
                  <thead>
                    <tr>{withKeys(b.head, (h) => h).map(({ key, item }) => <th key={key}>{inline(item, `${k}h${key}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {withKeys(b.rows, (r) => r.join("|")).map(({ key: row, item: r }) => (
                      <tr key={row}>{withKeys(r, (c) => c).map(({ key, item }) => <td key={key}>{inline(item, `${k}r${row}c${key}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <Fragment key={k} />;
        }
      })}
    </div>
  );
}
