import { expect, test } from "bun:test";
import { checkRequest, parseHosts } from "./guard";

function request(method: string, headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:8080/api/batch", { method, headers });
}

const json = { host: "localhost:8080", "content-type": "application/json" };

test("allows reads addressed to a local host name", () => {
  expect(checkRequest(request("GET", { host: "localhost:8080" }))).toBeNull();
  expect(checkRequest(request("GET", { host: "127.0.0.1:5173" }))).toBeNull();
});

test("rejects other host names (DNS rebinding)", () => {
  expect(checkRequest(request("GET", { host: "evil.example:8080" }))?.status).toBe(403);
});

test("also allows the extra host names it's given, such as a proxy's", () => {
  const extra = parseHosts(" Notes.Example, other.example ");
  expect(checkRequest(request("GET", { host: "notes.example" }), extra)).toBeNull();
  expect(checkRequest(request("GET", { host: "other.example:443" }), extra)).toBeNull();
  expect(checkRequest(request("GET", { host: "evil.example" }), extra)?.status).toBe(403);
});

test("no NETSEQ_HOSTS, or an empty one, adds no host names", () => {
  expect(parseHosts(undefined).size).toBe(0);
  expect(parseHosts(" , ").size).toBe(0);
});

test("allows same-origin JSON writes, and writes from tools like curl", () => {
  expect(checkRequest(request("POST", { ...json, "sec-fetch-site": "same-origin" }))).toBeNull();
  expect(checkRequest(request("POST", json))).toBeNull();
});

test("rejects cross-site writes and writes that aren't JSON", () => {
  expect(checkRequest(request("POST", { ...json, "sec-fetch-site": "cross-site" }))?.status).toBe(403);
  expect(checkRequest(request("POST", { host: "localhost:8080", "content-type": "text/plain" }))?.status).toBe(415);
});
