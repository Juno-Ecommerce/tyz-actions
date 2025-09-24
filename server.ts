import { App } from "@octokit/app";
import { Webhooks } from "@octokit/webhooks";
import invariant from "tiny-invariant";
import { createHmac, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";

import { handleSgcProductionPush } from "./processes/handle-sgc-production-push.js";

const { APP_ID, PRIVATE_KEY, WEBHOOK_SECRET } = process.env;
invariant(APP_ID, "APP_ID required");
invariant(PRIVATE_KEY, "PRIVATE_KEY required");
invariant(WEBHOOK_SECRET, "WEBHOOK_SECRET required");

const key = PRIVATE_KEY!.includes("\\n") ? PRIVATE_KEY!.replace(/\\n/g, "\n") : PRIVATE_KEY!;
const app = new App({ appId: APP_ID!, privateKey: key });
const webhooks = new Webhooks({ secret: WEBHOOK_SECRET! });

function checkInstallationId(payload: any) {
  const installationId = payload.installation?.id;
  if (!installationId) {
    console.log(`[${payload.repository.owner.login}/${payload.repository.name}] No installation ID found`);
    return false;
  }

  return true;
}

webhooks.on("push", async ({ id, name, payload }) => {
  console.log(`[webhook] ${name} id=${id} repo=${payload.repository.full_name} ref=${payload.ref}`);

  const installationId = payload.installation?.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  if (!checkInstallationId(payload)) return;

  const octokit = await app.getInstallationOctokit(Number(installationId));

  // Temporary: Only run on tryzens-core-framework repo
  if (repo !== "tryzens-core-framework") {
    console.log(`[${owner}/${repo}] Skipping - not tryzens-core-framework repo`);
    return;
  }

  switch (payload.ref) {
    case "refs/heads/sgc-production":
      if (payload.deleted) break;
      await handleSgcProductionPush(octokit, owner, repo);
      break;
    default:
      return;
  }
});

webhooks.onError((err) => {
  console.error("[webhook:error]", {
    name: err.name,
    message: err.message,
    event: (err as any).event,
    requestHeaders: (err as any).request?.headers && {
      event: (err as any).request.headers["x-github-event"],
      delivery: (err as any).request.headers["x-github-delivery"],
      sig256: ((err as any).request.headers["x-hub-signature-256"] || "").toString().slice(0, 20) + "…",
    },
  });
});

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  console.log(`[req] ${req.method} ${req.url}`);
  if (req.method !== "POST") { res.statusCode = 200; res.end("ok"); return; }

  const raw = await readRawBody(req);
  const secret = process.env.WEBHOOK_SECRET || "";
  const got = String(req.headers["x-hub-signature-256"] || "");
  const exp = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

  const eq = got.length === exp.length && timingSafeEqual(Buffer.from(got), Buffer.from(exp));
  console.log(`[sig] got=${got.slice(0,20)}… exp=${exp.slice(0,20)}… equal=${eq}`);

  if (!eq) { res.statusCode = 401; res.end("signature mismatch"); return; }

  // If signature matches, let Octokit parse & dispatch using the same raw bytes
  await webhooks.verifyAndReceive({
    id: String(req.headers["x-github-delivery"] || ""),
    name: String(req.headers["x-github-event"] || "") as any,
    payload: raw.toString("utf8"),
    signature: got
  }).catch(err => {
    console.error("[webhook:error]", err);
    res.statusCode = 400;
    res.end("webhook error");
  });

  res.statusCode = 200;
  res.end("ok");
}