/**
 * Picks how a tailored resume becomes a file.
 *
 * Preferred: `html-resume.js` — Chrome lays the page out, the fit is measured,
 * and the result is guaranteed to be one page in the layout the candidate
 * signed off on.
 *
 * Fallback: the original `generateDocx()` + LibreOffice path, for machines with
 * no Chrome. It cannot guarantee a page count, which is precisely why it is the
 * fallback and not the default.
 *
 * Set `RESUME_RENDERER=docx` to force the fallback (useful when the .docx is
 * the deliverable, or to compare the two).
 */

import { generateDocx } from './document.js';
import { convertToPdf, cleanupDocx, checkLibreOffice } from './converter.js';
import { renderResumePdf, checkHtmlRenderer } from './html-resume.js';

// checkHtmlRenderer() shells out to `chrome --version`; the answer cannot change
// while the process lives, so resolve it once.
let _htmlReady = null;
export function htmlRendererAvailable() {
  if (process.env.RESUME_RENDERER === 'docx') return Promise.resolve(false);
  if (!_htmlReady) _htmlReady = checkHtmlRenderer();
  return _htmlReady;
}

/**
 * Produce the resume file, best engine first.
 *
 * @param {object} aiResponse - tailored payload (title/summary/bullets/skills/…)
 * @param {object} resumeData - candidate's stored resume
 * @param {{docx: string, pdf: string}} outputPaths
 * @returns {Promise<{path: string, engine: 'html'|'libreoffice'|'docx', pages?: number, scale?: number, trimLevel?: number}>}
 */
export async function renderResume(aiResponse, resumeData, outputPaths) {
  if (await htmlRendererAvailable()) {
    try {
      const r = await renderResumePdf(aiResponse, resumeData, outputPaths.pdf);
      return { path: r.path, engine: 'html', pages: r.pages, scale: r.scale, trimLevel: r.trimLevel };
    } catch (error) {
      // A Chrome crash or a font failure must not cost the user their resume —
      // fall through to the path that worked before this renderer existed.
      console.warn(`⚠️  One-page HTML render failed (${error.message}) — falling back to DOCX`);
    }
  }

  const docxPath = await generateDocx(aiResponse, outputPaths, resumeData);
  if (checkLibreOffice()) {
    const pdfPath = await convertToPdf(docxPath, outputPaths.pdf);
    cleanupDocx(docxPath);
    return { path: pdfPath, engine: 'libreoffice' };
  }
  return { path: docxPath, engine: 'docx' };
}

export default { renderResume, htmlRendererAvailable };
