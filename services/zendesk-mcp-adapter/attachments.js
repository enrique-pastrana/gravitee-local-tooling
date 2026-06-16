// Attachment extraction and content decoding helpers.

/**
 * Return all formal attachments (uploaded files) from a list of Zendesk comments.
 */
export function extractFormalAttachments(comments) {
  const attachments = [];
  for (const comment of comments) {
    for (const att of comment.attachments || []) {
      if (att.content_url && att.content_type) {
        attachments.push({
          source: "attachment",
          comment_id: comment.id,
          attachment_id: att.id,
          file_name: att.file_name,
          content_type: att.content_type,
          content_url: att.content_url,
          size: att.size,
          inline: att.inline || false,
        });
      }
    }
  }
  return attachments;
}

/**
 * Return all inline images found in comment bodies
 * (markdown ![alt](url) and HTML <img src="url"> patterns).
 */
export function extractInlineImages(comments) {
  const images = [];
  const seen = new Set();

  const mdRegex = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
  const htmlRegex = /(?:src)=["'](https?:\/\/[^"']+\/attachments\/[^"']+)["']/gi;

  for (const comment of comments) {
    const body = comment.body || "";

    for (const regex of [mdRegex, htmlRegex]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(body)) !== null) {
        const url = match[1];
        if (!seen.has(url)) {
          seen.add(url);
          // Prefer the ?name= query param (Zendesk token URLs use this pattern),
          // fall back to the last path segment's extension.
          const nameParam = new URL(url).searchParams.get("name") || "";
          const extFromName = nameParam.includes(".") ? nameParam.split(".").pop().toLowerCase() : "";
          const extFromPath = url.split("?")[0].split("/").pop().split(".").pop().toLowerCase();
          const ext = extFromName || extFromPath;
          const extMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
          const content_type = extMap[ext] || "image/png";
          const file_name = nameParam || `image.${ext || "png"}`;
          images.push({
            source: "inline",
            comment_id: comment.id,
            attachment_id: null,
            file_name,
            content_type,
            content_url: url,
            size: null,
            inline: true,
          });
        }
      }
    }
  }
  return images;
}

/**
 * Attempt to decode a base64 buffer as UTF-8 text.
 * Returns the decoded string, or null if the content is not valid UTF-8
 * (e.g. a binary / binary-like file).
 */
export function decodeAsText(base64) {
  try {
    const text = Buffer.from(base64, "base64").toString("utf-8");
    const replacementRatio = (text.match(/�/g) || []).length / (text.length || 1);
    if (replacementRatio > 0.05) return null;
    return text;
  } catch (_err) {
    return null;
  }
}
