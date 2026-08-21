// Wraps @netlify/blobs' getStore(). Netlify normally auto-injects the site
// context (siteID + token) into functions so getStore(name) "just works" -
// but some deploys don't get that context (MissingBlobsEnvironmentError).
// If BLOBS_SITE_ID and BLOBS_TOKEN are set, we pass them explicitly, which
// works regardless of whether auto-injection is functioning.

const { getStore } = require('@netlify/blobs');

function getNamedStore(name) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  return getStore(name);
}

module.exports = { getNamedStore };
