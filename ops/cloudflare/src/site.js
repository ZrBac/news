// Set the public origin in the deployment environment. Missing or malformed
// configuration must never authorize a caller or choose an upstream host.
export function siteOrigin(env) {
  const match = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec((env.NEWS_SITE_URL || "").trim());
  if (!match || match[1].split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
    throw new Error("site_not_configured");
  return "https://" + match[1].toLowerCase();
}

export function siteOrigins(env) {
  try {
    const origin = siteOrigin(env);
    return new Set([origin, origin.replace(/^https:/, "http:")]);
  } catch {
    return new Set();
  }
}
