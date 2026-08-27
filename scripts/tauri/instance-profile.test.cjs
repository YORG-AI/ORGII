const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createInstanceProfile,
  parseInstanceId,
} = require("./instance-profile.cjs");

test("instance 2 receives isolated identity, schemes, and ports", () => {
  const profile = createInstanceProfile("2");
  assert.equal(profile.identifier, "org2ai.org2.instance2");
  assert.equal(profile.authDeepLinkScheme, "orgii-instance2");
  assert.equal(profile.ideServerPort, 13848);
  assert.equal(profile.cliProxyPort, 17889);
  assert.match(profile.dataHome, /\.orgii-instance2$/);
});

test("primary and unbounded instance ids are rejected", () => {
  for (const value of [undefined, "1", "2.5", "100", "abc"]) {
    assert.throws(() => parseInstanceId(value));
  }
});
