/**
 * The one shape every Spawnpoint email is poured into.
 *
 * Email is the panel's own world drawn with a much smaller box of tools: no
 * stylesheet survives the journey, layout is tables, and the mark is a hosted
 * PNG because the clients that matter strip SVG. What does survive is the
 * grammar — a white card on the grey canvas, a hairline border, one blue
 * action, Roboto where it is installed and the system sans where it is not.
 *
 * Everything that came from a person or a token is escaped here, once, so a
 * caller cannot forget.
 */

export type EmailLayout = Readonly<{
  /** Where the panel is served, so the mark and every link resolve absolutely. */
  panelUrl: string;
  /** The `<title>` and the heading; also the plain-text first line. */
  title: string;
  /** "Hi Ada," — the display name is escaped, whatever it contains. */
  greeting: string;
  /** Body paragraphs, in order. */
  paragraphs: readonly string[];
  /** The one action, drawn as a button and repeated as a bare link beneath it. */
  action: Readonly<{ label: string; url: string }>;
  /** The small print: expiry, and what to do if this was not you. */
  note: string;
}>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The panel's tokens, written out: a mail client reads none of ours.
const CANVAS = "#f1f1f1";
const SURFACE = "#ffffff";
const OUTLINE = "#dcdcdc";
const INK = "#1f1f1f";
const INK_SECONDARY = "#5f5f5f";
const PRIMARY = "#1a73e8";
const ON_PRIMARY = "#ffffff";
const FONT_UI = "Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT_TITLE = "'Google Sans Flex', 'Google Sans', Roboto, 'Helvetica Neue', Arial, sans-serif";

export function markUrl(panelUrl: string): string {
  return `${panelUrl.replace(/\/$/, "")}/email/mark.png`;
}

export function renderEmailHtml(input: EmailLayout): string {
  const title = escapeHtml(input.title);
  const url = escapeHtml(input.action.url);
  const paragraphs = input.paragraphs
    .map((text) => `<p style="margin:0 0 16px;font:400 14px/22px ${FONT_UI};color:${INK};">${escapeHtml(text)}</p>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${SURFACE};border:1px solid ${OUTLINE};border-radius:8px;">
    <tr><td style="padding:24px 28px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;padding-right:12px;">
            <img src="${escapeHtml(markUrl(input.panelUrl))}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:8px;">
          </td>
          <td style="vertical-align:middle;font:500 20px/24px ${FONT_TITLE};color:${INK};">Spawnpoint</td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:24px 28px 0;">
      <h1 style="margin:0 0 16px;font:400 22px/28px ${FONT_TITLE};color:${INK};">${title}</h1>
      <p style="margin:0 0 16px;font:400 14px/22px ${FONT_UI};color:${INK};">${escapeHtml(input.greeting)}</p>
      ${paragraphs}
    </td></tr>
    <tr><td style="padding:4px 28px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="border-radius:4px;background:${PRIMARY};">
          <a href="${url}" style="display:inline-block;padding:0 16px;font:500 14px/36px ${FONT_UI};color:${ON_PRIMARY};text-decoration:none;border-radius:4px;">${escapeHtml(input.action.label)}</a>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:16px 28px 0;">
      <p style="margin:0;font:400 12px/16px ${FONT_UI};color:${INK_SECONDARY};">If the button does not work, open this link:</p>
      <p style="margin:4px 0 0;font:400 12px/16px ${FONT_UI};word-break:break-all;"><a href="${url}" style="color:${PRIMARY};text-decoration:underline;">${url}</a></p>
    </td></tr>
    <tr><td style="padding:24px 28px 0;">
      <hr style="margin:0;border:0;border-top:1px solid ${OUTLINE};">
    </td></tr>
    <tr><td style="padding:16px 28px 24px;">
      <p style="margin:0;font:400 12px/16px ${FONT_UI};color:${INK_SECONDARY};">${escapeHtml(input.note)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}
