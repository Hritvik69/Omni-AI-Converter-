import { readFile, stat } from "node:fs/promises";
import { resourceLimits } from "@omniconvert/shared";

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&amp;/gi, "&");
}

function cleanUrl(value: string): string {
  return decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
}

function assertSafeInlineUrl(rawValue: string): void {
  const value = cleanUrl(rawValue);
  if (!value || value.startsWith("#")) return;

  const lower = value.toLowerCase();
  if (lower.startsWith("data:")) {
    if (/^data:(?:image\/|font\/|application\/font-|application\/vnd\.ms-fontobject|application\/x-font-)/i.test(value)) {
      return;
    }
    throw new Error("HTML rendering allows only data: image/font assets");
  }

  if (lower === "about:blank") return;
  if (lower.startsWith("//") || lower.startsWith("/") || lower.startsWith(".") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error("HTML rendering blocks external, local, and relative resource URLs");
  }

  throw new Error("HTML rendering allows only inline assets");
}

function extractSrcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter((item): item is string => Boolean(item));
}

export async function assertSafeHtmlForImageRender(inputPath: string): Promise<void> {
  const fileStat = await stat(inputPath);
  if (fileStat.size > resourceLimits.maxHtmlInputBytes) {
    throw new Error(`HTML input exceeds ${resourceLimits.maxHtmlInputBytes} bytes`);
  }

  const html = await readFile(inputPath, "utf8");
  const lowered = decodeHtmlEntities(html).toLowerCase();
  if (/<\s*(?:script|iframe|object|embed|applet|base)\b/i.test(lowered)) {
    throw new Error("HTML rendering blocks active or document-loading elements");
  }
  if (/<\s*meta\b[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)/i.test(lowered)) {
    throw new Error("HTML rendering blocks meta refresh");
  }

  const attrPattern =
    /\b(src|href|poster|background|data|action|formaction|manifest|xlink:href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(attrPattern)) {
    const attr = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (attr === "srcset") {
      for (const url of extractSrcsetUrls(value)) assertSafeInlineUrl(url);
    } else {
      assertSafeInlineUrl(value);
    }
  }

  const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]+))\s*\)/gi;
  for (const match of html.matchAll(cssUrlPattern)) {
    assertSafeInlineUrl(match[1] ?? match[2] ?? match[3] ?? "");
  }

  const cssImportPattern = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^'")\s;]+))/gi;
  for (const match of html.matchAll(cssImportPattern)) {
    assertSafeInlineUrl(match[1] ?? match[2] ?? match[3] ?? "");
  }
}
