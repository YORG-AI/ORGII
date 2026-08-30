import assert from "node:assert/strict";

const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;

describe("CLI session resume lock isolation", function () {
  this.timeout(30_000);

  it("does not block unrelated session starts behind stale resume cleanup", async function () {
    const response = await fetch(
      `${E2E_BASE_URL}/agent/test/cli/resume-lock-isolation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }
    );
    const body = await response.json();

    assert.equal(response.ok, true, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.peer_result_ok, true, JSON.stringify(body));
    assert.equal(body.resume_result_ok, true, JSON.stringify(body));
    assert.ok(
      body.peer_start_ms < 1500,
      `peer session start was blocked by unrelated resume cleanup: ${JSON.stringify(body)}`
    );
  });
});
