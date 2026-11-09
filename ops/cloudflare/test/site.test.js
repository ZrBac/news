import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import {siteOrigin, siteOrigins} from "../src/site.js";

test("deployment origin authorizes only that host, including its legacy HTTP entry", async () => {
  const env = {NEWS_SITE_URL: "https://Reader.Example.org/"};
  assert.equal(siteOrigin(env), "https://reader.example.org");
  for (const origin of ["https://reader.example.org", "http://reader.example.org", "https://news.example.com",
    "https://reader.example.org.evil.example", "null"]) {
    const response = await worker.fetch(new Request("https://worker.example/api/news-refresh", {
      method: "OPTIONS", headers: {Origin: origin},
    }), env);
    const allowed = origin === "https://reader.example.org" || origin === "http://reader.example.org";
    assert.equal(response.status, allowed ? 200 : 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowed ? origin : null);
  }
});

test("missing or malformed deployment origin fails closed without reflecting callers", async () => {
  for (const value of [undefined, "", "http://example.org", "//example.org", "https://user@example.org",
    "https://example.org:8443", "https://example.org/path", "https://example.org/?next=other",
    "https://example.org/#fragment", "https://example..org", "https://-example.org"]) {
    const env = {NEWS_SITE_URL: value};
    assert.throws(() => siteOrigin(env), /site_not_configured/);
    assert.equal(siteOrigins(env).size, 0);
    const response = await worker.fetch(new Request("https://worker.example/api/outings/profile", {
      method: "POST", headers: {Origin: "https://example.org"}, body: "{}",
    }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
});
