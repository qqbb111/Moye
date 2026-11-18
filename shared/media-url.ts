// Older drafts store replica-media URLs in their Markdown. The same attachment
// filename serves both formats without rewriting the user's draft text.
export function draftImageName(url: string) {
  return /^(?:moye|replica)-media:\/\/draft\/([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico))$/i.exec(url)?.[1];
}
