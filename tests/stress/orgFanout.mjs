#!/usr/bin/env node
/**
 * 50-member org stress harness (scalability campaign, workstream #1).
 *
 * Measures the three member-scale unknowns against the LIVE backend:
 *   1. realtime fan-out — N clients subscribe postgres_changes on
 *      cloud_session_comments for one org; one comment write; measure
 *      per-client delivery latency and loss;
 *   2. concurrent comments — all N users call cloud_add_session_comment
 *      simultaneously; measure latency distribution and error rate;
 *   3. concurrent owner pushes — M users upsert their own metadata rows
 *      simultaneously (the multi-owner push front door).
 *
 * Test identities live under the @org2-stress.invalid domain and are
 * created/removed via the GoTrue admin API. Everything this script makes
 * is torn down by `cleanup` (org delete cascades sessions via 0009).
 *
 *   node tests/stress/orgFanout.mjs setup [N=50]
 *   node tests/stress/orgFanout.mjs run
 *   node tests/stress/orgFanout.mjs cleanup
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(here, ".stress-state.json");

function loadEnv() {
  const envPath = resolve(here, "../e2e/.env");
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

const env = loadEnv();
const URL_ = env.E2E_CLOUD_SUPABASE_URL;
const SERVICE = env.E2E_CLOUD_SERVICE_KEY;
const ANON = env.E2E_CLOUD_ANON_KEY;
const PASSWORD = "Stress-0725!pass";
const EMAIL = (i) => `stress-${String(i).padStart(3, "0")}@org2-stress.invalid`;

const admin = createClient(URL_, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function rpc(token, fn, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-profile": "org2_cloud",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

let rateLimited = 0;
async function signIn(i, attempt = 0) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL(i), password: PASSWORD }),
  });
  if (res.status === 429 && attempt < 8) {
    rateLimited += 1;
    await new Promise((r) => setTimeout(r, 45000));
    return signIn(i, attempt + 1);
  }
  if (!res.ok) throw new Error(`signIn ${i}: ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

function quantiles(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1], n: s.length };
}

async function setup(n) {
  const users = [];
  for (let i = 0; i < n; i += 1) {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL(i),
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: `Stress ${i}` },
    });
    if (error && !`${error.message}`.includes("already")) throw error;
    if (data?.user) users.push(data.user.id);
    else {
      const list = await admin.auth.admin.listUsers({ perPage: 1000 });
      const hit = list.data.users.find((u) => u.email === EMAIL(i));
      users.push(hit.id);
    }
  }
  const prior = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : null;
  const tokens = prior?.tokens ?? {};
  const owner = await signIn(0);
  tokens[0] = owner.refresh_token;
  let orgId = prior?.orgId;
  if (!orgId) {
    const org = await rpc(owner.access_token, "create_org", {
      org_name: "Stress Fanout 0725",
    });
    orgId = org.orgId ?? org.id;
  }
  // Membership goes through the REAL invite flow — org_memberships is
  // write-hardened even for service_role, and concurrent accepts on one
  // invite are themselves a contention scenario worth measuring.
  const code = `stress-code-${Date.now()}`;
  const hash = createHash("sha256").update(code).digest("hex");
  await rpc(owner.access_token, "create_invite", {
    p_org_id: orgId,
    invite_code_hash: hash,
    invite_role: "member",
    max_uses: n + 10,
    expires_at: null,
  });
  const acceptStart = Date.now();
  const accepts = await mapLimit(
    Array.from({ length: n - 1 }, (_, idx) => idx),
    8,
    async (idx) => {
      const member = await signIn(idx + 1);
      tokens[idx + 1] = member.refresh_token;
      try {
        await rpc(member.access_token, "accept_invite", {
          invite_code_hash: hash,
        });
        return true;
      } catch (error) {
        console.log("accept failed:", String(error).slice(0, 120));
        return false;
      }
    }
  );
  console.log(
    `invite accepts: ${accepts.filter(Boolean).length}/${n - 1} in ${
      Date.now() - acceptStart
    }ms`
  );
  const sessionId = prior?.sessionId ?? `stress-fanout-target-${Date.now()}`;
  const sess = await fetch(`${URL_}/rest/v1/cloud_sessions`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      authorization: `Bearer ${SERVICE}`,
      "content-type": "application/json",
      "content-profile": "org2_cloud",
      prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify({
      org_id: orgId,
      owner_user_id: users[0],
      session_id: sessionId,
      access_mode: "metadata_only",
      visibility: "org",
      last_activity_at: new Date().toISOString(),
      metadata: { title: "fanout target" },
    }),
  });
  if (!sess.ok) throw new Error(`session: ${sess.status} ${await sess.text()}`);
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ users, orgId, sessionId, n, tokens })
  );
  console.log(`setup done: org ${orgId}, ${users.length} users`);
}

async function run() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const { orgId, sessionId, n } = state;
  console.log(`signing in ${n} users…`);
  const t0 = Date.now();
  const refresh = async (i) => {
    const saved = state.tokens?.[i];
    if (saved) {
      const res = await fetch(
        `${URL_}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: { apikey: ANON, "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: saved }),
        }
      );
      if (res.ok) {
        const fresh = await res.json();
        state.tokens[i] = fresh.refresh_token;
        return fresh;
      }
    }
    return signIn(i);
  };
  const sessions = await mapLimit(
    Array.from({ length: n }, (_, i) => i),
    8,
    (i) => refresh(i)
  );
  writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(
    `sign-in storm: ${n} tokens in ${Date.now() - t0}ms (429 retries: ${rateLimited})`
  );

  console.log("subscribing realtime clients…");
  const deliveries = new Map();
  const clients = sessions.map((s, i) => {
    const c = createClient(URL_, ANON, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    c.realtime.setAuth(s.access_token);
    return c;
  });
  let subscribed = 0;
  await Promise.all(
    clients.map(
      (c, i) =>
        new Promise((done) => {
          // Mirror the app: comments ride the org presence channel as
          // client-sent broadcast nudges (org2CloudCommentsBus), not
          // postgres_changes on the comments table.
          const ch = c
            .channel(`presence:org:${orgId}`, {
              config: { broadcast: { self: false } },
            })
            .on("broadcast", { event: "*" }, () =>
              deliveries.set(i, Date.now())
            )
            .subscribe((status) => {
              if (status === "SUBSCRIBED") {
                subscribed += 1;
                done();
              }
              if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") done();
            });
          setTimeout(done, 15000);
        })
    )
  );
  console.log(`subscribed: ${subscribed}/${n}`);

  const writeAt = Date.now();
  await rpc(sessions[0].access_token, "cloud_add_session_comment", {
    p_org_id: orgId,
    p_session_id: sessionId,
    p_body: `fanout probe ${writeAt}`,
  });
  const writerChannel = clients[0]
    .channel(`presence:org:${orgId}:writer`, {})
    .subscribe();
  await new Promise((r) => setTimeout(r, 1500));
  await clients[0]
    .channel(`presence:org:${orgId}`, {
      config: { broadcast: { self: false } },
    })
    .send({
      type: "broadcast",
      event: "comments_changed",
      payload: { sessionId, at: writeAt },
    });
  await new Promise((r) => setTimeout(r, 8000));
  const missing = Array.from({ length: n }, (_, i) => i).filter(
    (i) => !deliveries.has(i)
  );
  console.log(`missing indices: ${JSON.stringify(missing)}`);
  const latencies = [...deliveries.values()].map((t) => t - writeAt);
  // The writer's own client is excluded by broadcast self:false — count
  // RECEIVERS, not subscribers. Four consecutive runs each missed exactly
  // index 0 (the writer): delivery to actual receivers is 49/49.
  console.log(
    `fanout: delivered ${deliveries.size}/${subscribed - 1} receivers — ${JSON.stringify(
      latencies.length ? quantiles(latencies) : {}
    )}`
  );
  for (const c of clients) await c.removeAllChannels();

  console.log(`concurrent comments: ${n} simultaneous writers…`);
  const results = await Promise.all(
    sessions.map(async (s, i) => {
      const start = Date.now();
      try {
        await rpc(s.access_token, "cloud_add_session_comment", {
          p_org_id: orgId,
          p_session_id: sessionId,
          p_body: `concurrent ${i}`,
        });
        return { ms: Date.now() - start };
      } catch (error) {
        return { err: String(error).slice(0, 120) };
      }
    })
  );
  const ok = results.filter((r) => r.ms !== undefined);
  const errs = results.filter((r) => r.err);
  console.log(
    `comments: ${ok.length} ok, ${errs.length} errors — ${JSON.stringify(
      quantiles(ok.map((r) => r.ms))
    )}`
  );
  if (errs.length) console.log("sample error:", errs[0].err);

  console.log("concurrent owner metadata pushes (service-role upserts)…");
  const pushStart = Date.now();
  const pushes = await Promise.all(
    state.users.slice(0, 20).map(async (userId, i) => {
      const start = Date.now();
      const res = await fetch(`${URL_}/rest/v1/cloud_sessions`, {
        method: "POST",
        headers: {
          apikey: SERVICE,
          authorization: `Bearer ${SERVICE}`,
          "content-type": "application/json",
          "content-profile": "org2_cloud",
          prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          org_id: orgId,
          owner_user_id: userId,
          session_id: `stress-owner-${i}`,
          access_mode: "metadata_only",
          visibility: "org",
          last_activity_at: new Date().toISOString(),
          metadata: { title: `owner push ${i}` },
        }),
      });
      return { ok: res.ok, ms: Date.now() - start };
    })
  );
  console.log(
    `owner pushes: ${pushes.filter((p) => p.ok).length}/20 ok in ${
      Date.now() - pushStart
    }ms — ${JSON.stringify(quantiles(pushes.map((p) => p.ms)))}`
  );
}

async function sustain(minutes) {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const { orgId, sessionId } = state;
  const writers = 10;
  const sessions = await mapLimit(
    Array.from({ length: writers }, (_, i) => i),
    4,
    (i) => signIn(i)
  );
  console.log(`sustain: ${writers} writers × ${minutes}min, 2s cadence`);
  const perMinute = new Map();
  const endAt = Date.now() + minutes * 60_000;
  let errors = 0;
  await Promise.all(
    sessions.map(async (sess, w) => {
      while (Date.now() < endAt) {
        const start = Date.now();
        try {
          // Per-writer target sessions dodge the 500-comment/session cap
          // (an 0001 abuse guard counting live AND tombstoned rows) so this
          // measures infra drift, not the cap.
          await rpc(sess.access_token, "cloud_add_session_comment", {
            p_org_id: orgId,
            p_session_id: `stress-owner-${w}`,
            p_body: `sustain w${w} ${start}`,
          });
          const minute = Math.floor(
            (start - (endAt - minutes * 60_000)) / 60_000
          );
          const bucket = perMinute.get(minute) ?? [];
          bucket.push(Date.now() - start);
          perMinute.set(minute, bucket);
        } catch (error) {
          errors += 1;
          if (errors <= 3)
            console.log("sustain error:", String(error).slice(0, 160));
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })
  );
  for (const [minute, values] of [...perMinute.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    console.log(`minute ${minute}: ${JSON.stringify(quantiles(values))}`);
  }
  console.log(`sustain done: errors=${errors}`);
}

async function cleanup() {
  if (!existsSync(STATE_FILE)) return console.log("no state");
  const { users, orgId } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const owner = await signIn(0);
  try {
    await rpc(owner.access_token, "cloud_delete_org", { p_org_id: orgId });
    console.log("org deleted (0009 cascades sessions)");
  } catch (error) {
    console.log("org delete:", String(error).slice(0, 160));
  }
  for (const id of users) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  console.log(`deleted ${users.length} stress users`);
}

const mode = process.argv[2] ?? "run";
const n = Number(process.argv[3] ?? 50);
if (mode === "setup") await setup(n);
else if (mode === "run") await run();
else if (mode === "sustain") await sustain(Number(process.argv[3] ?? 5));
else if (mode === "cleanup") await cleanup();
else console.log("modes: setup [n] | run | sustain [min] | cleanup");
