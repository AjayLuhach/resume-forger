// The sign-off appended to every outgoing draft — feed emails, mail replies,
// re-drafts. One builder, so a candidate without a portfolio or a
// GitHub never prints the literal word "undefined" (or a blank line) under
// their name in an email. Only the fields the candidate filled in appear.
//
//   buildSignoff(candidate)                  → "\n\nCurrent salary: … | Expected salary: …\n\nRegards,\nName\n<links…>"
//   buildSignoff(candidate, { salary: false }) → just the Regards block
//   hasSignoff(body, candidate)              → true when the body already carries it

export const signoffLinks = (candidate) =>
  [candidate?.portfolio, candidate?.linkedin, candidate?.github].filter(Boolean);

export function buildSignoff(candidate, { salary = true } = {}) {
  const c = candidate || {};
  const salaryLine = salary && c.currentCTC && c.expectedCTC
    ? `\n\nCurrent salary: ${c.currentCTC} | Expected salary: ${c.expectedCTC}`
    : '';
  return `${salaryLine}\n\nRegards,\n${[c.name, ...signoffLinks(c)].filter(Boolean).join('\n')}`;
}

// A body already carrying one of the sign-off's links (or, for a candidate
// with no links at all, the "Regards, <name>" line) is left alone.
export function hasSignoff(body, candidate) {
  const text = String(body || '');
  const marks = signoffLinks(candidate);
  if (marks.length) return marks.some((m) => text.includes(m));
  return !!candidate?.name && text.includes(`Regards,\n${candidate.name}`);
}
