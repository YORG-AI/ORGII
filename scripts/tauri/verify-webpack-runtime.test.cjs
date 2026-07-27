const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { verifyWebpackRuntimeGuards } = require("./verify-webpack-runtime.cjs");

function withBuild(files, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orgii-runtime-guard-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
    callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts current runtime and emitted chunk guard ids", () => {
  withBuild(
    {
      "runtime.abc.js":
        '(()=>{r.u=e=>({48866:"orgii-chat-projection"}[e]);r.j=49121;})();',
      "1493.def.js": "if(r.j==49121){} if(r.j==48866){} if(r.j==0){}",
      "orgii-chat-projection.ghi.js": "self.webpackChunk_orgii=[];",
    },
    (dir) => {
      assert.deepEqual(verifyWebpackRuntimeGuards(dir), {
        runtimeId: "49121",
        assetsChecked: 3,
      });
    }
  );
});

test("rejects a stale cached runtime guard", () => {
  withBuild(
    {
      "runtime.abc.js": "(()=>{r.j=49121;})();",
      "1493.def.js": "if(r.j==9121){var jotai=r(31346)}",
    },
    (dir) => {
      assert.throws(
        () => verifyWebpackRuntimeGuards(dir),
        /stale runtime guard\(s\); runtime=49121: 9121 in 1493\.def\.js/
      );
    }
  );
});
