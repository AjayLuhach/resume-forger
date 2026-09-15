// Content-Disposition that survives any filename.
//
// Node rejects a header value with characters outside Latin-1, so a job title
// with an en dash ("Software Engineer – Backend") used to turn every PDF
// download into a 500. RFC 6266 / RFC 5987 solve it with two parameters: an
// ASCII fallback in `filename=` for old clients and the real UTF-8 name,
// percent-encoded, in `filename*=`. Browsers prefer the second.
export function contentDisposition(disposition, filename) {
  const name = String(filename || 'download');
  const ascii = name.replace(/[^\x20-\x7e]+/g, '-').replace(/["\\]/g, '').replace(/-{2,}/g, '-');
  const encoded = encodeURIComponent(name)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
