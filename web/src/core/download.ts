/**
 * Opens a presigned link in a new tab. The tab opens during the click, while
 * the browser still counts it as the person's own; waiting for the API first
 * makes a valid download look like an unsolicited pop-up. The link expires
 * and is never kept.
 */
export async function openDownload<Link extends { url: string }>(request: () => Promise<Link>): Promise<Link> {
  const tab = window.open("about:blank", "_blank");
  if (tab !== null) tab.opener = null;
  try {
    const link = await request();
    if (tab !== null) tab.location.replace(link.url); else window.location.assign(link.url);
    return link;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
