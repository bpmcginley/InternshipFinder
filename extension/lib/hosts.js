// Which sites InternScout may touch.
//
// The extension used to ask for <all_urls> at install, which makes Chrome warn "Read and change all
// your data on all websites" before a student has seen the product do anything. For something handed
// round a student forum that warning is the whole first impression, so the manifest now grants only
// the applicant-tracking systems below and asks for anything else at the moment it is needed.
//
// These 19 domains carry 81% of the listings we index: 8,211 of the 10,142 open postings in
// docs/data/listings on 2026-09-18, counted once per listing rather than once per state shard. The
// other 1,931 sit on 161 employer-owned hosts -- lifeattiktok.com, careers.qorvo.com, www.tesla.com,
// careers.jhuapl.edu -- and no single one of them is more than 1.5% of the data. That tail grows
// with every employer added, and a good part of it is by design: an employer running an iCIMS or
// SuccessFactors career site serves it from its own domain. It cannot be enumerated in a manifest
// that only changes at a store review, so those are handled by an in-context request for that one
// site.
export const ATS_HOSTS = [
  "myworkdayjobs.com", "myworkdaysite.com", "greenhouse.io", "lever.co", "ashbyhq.com",
  "smartrecruiters.com", "oraclecloud.com", "icims.com", "taleo.net", "workable.com",
  "rippling.com", "bamboohr.com", "jobvite.com", "recruitee.com", "adp.com",
  "successfactors.com", "paylocity.com", "applytojob.com",
  // An ATS like the rest, though its boards read as employer subdomains: micron.eightfold.ai.
  "eightfold.ai",
];

// Match patterns for manifest.json "host_permissions". Every board we have seen on these systems is on
// a subdomain (job-boards.greenhouse.io, boeing.wd1.myworkdayjobs.com), which is what "*." covers.
export const ATS_MATCHES = ATS_HOSTS.map((d) => `https://*.${d}/*`);

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// The narrowest pattern that covers this page: one scheme, one host. Asking for "tesla.com" reads very
// differently to a student than asking for every site, so never widen this to <all_urls>.
export function originPattern(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return `${u.protocol}//${u.hostname}/*`;
}

export function isAtsHost(url) {
  const h = hostOf(url).toLowerCase();
  return ATS_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

// Granted at install, granted earlier by the student, or not granted at all. Anything we cannot parse
// counts as granted so this check never becomes the reason a job fails -- injection will say why.
export async function hasHostAccess(url, perms = chrome.permissions) {
  const origins = originPattern(url);
  if (!origins) return true;
  return perms.contains({ origins: [origins] }).catch(() => false);
}

// Must run from an extension page during a click: Chrome refuses a permission request without a
// gesture, and the service worker never has one.
export async function requestHostAccess(url, perms = chrome.permissions) {
  const origins = originPattern(url);
  if (!origins) return false;
  return perms.request({ origins: [origins] }).catch(() => false);
}
