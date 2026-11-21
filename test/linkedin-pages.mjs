// LinkedIn "Company pages only": never asks for or adds the personal profile.
import assert from "node:assert/strict";
import * as li from "../netlify/lib/platforms/linkedin.mjs";

const base = { clientId: "cid", clientSecret: "sec", version: "202608" };
const urls = [];
function mockFetch(handler) {
  globalThis.fetch = async (url, opts = {}) => {
    urls.push(String(url));
    const { status = 200, body = {} } = handler(String(url), opts);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

// 1. Default is pages only: scopes have no personal-profile permissions.
const sc = li.scopes({ linkedin: { ...base } });
assert.equal(sc, "w_organization_social r_organization_social rw_organization_admin");
assert.ok(!sc.includes("w_member_social") && !sc.includes("openid"));
assert.ok(li.authUrl({ settings: { linkedin: { ...base } }, redirectUri: "https://x/cb", state: "s" }).includes("w_organization_social"));

// 2. Turning it off brings back the personal profile scopes.
assert.ok(li.scopes({ linkedin: { ...base, pagesOnly: false } }).includes("w_member_social"));

// 3. Callback in pages-only mode: only the LIFTLINE page, no userinfo call.
mockFetch((url) => {
  if (url.includes("accessToken")) return { body: { access_token: "tok", expires_in: 5184000 } };
  if (url.includes("organizationAcls")) return { body: { elements: [{ organization: "urn:li:organization:12345" }] } };
  if (url.includes("/organizations/12345")) return { body: { localizedName: "LIFTLINE", vanityName: "liftline" } };
  return { status: 404, body: { message: "unexpected" } };
});
const out = await li.callback({ settings: { linkedin: { ...base } }, redirectUri: "https://x/cb", code: "c" });
assert.equal(out.length, 1);
assert.equal(out[0].kind, "li_org");
assert.equal(out[0].name, "LIFTLINE");
assert.equal(out[0].meta.urn, "urn:li:organization:12345");
assert.ok(!urls.some((u) => u.includes("userinfo")), "personal profile must not be read");

// 4. Not approved yet: a clear message instead of silently adding the personal profile.
mockFetch((url) => {
  if (url.includes("accessToken")) return { body: { access_token: "tok", expires_in: 5184000 } };
  return { status: 403, body: { message: "Not enough permissions to access: organizationAcls" } };
});
await assert.rejects(li.callback({ settings: { linkedin: { ...base } }, redirectUri: "https://x/cb", code: "c" }), /Community Management API/);

// 5. Approved but not an admin of any page.
mockFetch((url) => {
  if (url.includes("accessToken")) return { body: { access_token: "tok", expires_in: 5184000 } };
  if (url.includes("organizationAcls")) return { body: { elements: [] } };
  return { status: 404, body: {} };
});
await assert.rejects(li.callback({ settings: { linkedin: { ...base } }, redirectUri: "https://x/cb", code: "c" }), /No LinkedIn Company Page/);

console.log("linkedin pages-only: all good");
