import { App } from "@octokit/app";
import { createNodeMiddleware, Webhooks } from "@octokit/webhooks";
import http from "http";
import invariant from "tiny-invariant";

// --- env ---
const {
  APP_ID,
  PRIVATE_KEY, // PEM content
  WEBHOOK_SECRET,
  PORT = "3000"
} = process.env;

invariant(APP_ID, "APP_ID required");
invariant(PRIVATE_KEY, "PRIVATE_KEY required");
invariant(WEBHOOK_SECRET, "WEBHOOK_SECRET required");

// Octokit App (used to auth as installation per repo)
const app = new App({ appId: APP_ID, privateKey: PRIVATE_KEY });

// Webhooks verifier/dispatcher
const webhooks = new Webhooks({ secret: WEBHOOK_SECRET });

async function pushSgcProduction(payload: PushEvent) {
  const installationId = payload.installation?.id;
  const owner = payload.repository.owner.login;
  const repo  = payload.repository.name;

  // Auth as the installation for this repo
  const octokit = await app.getInstallationOctokit(installationId);

  // A) Fast-forward/merge sgc-production -> production when possible
  try {
    await octokit.request("POST /repos/{owner}/{repo}/merges", {
      owner, repo,
      base: "production",
      head: "sgc-production"
      // merge_method not supported here; this API does FF or merge commit automatically
    });
    console.log(`[${owner}/${repo}] merged sgc-production -> production`);
    return;
  } catch (e) {
    // 409 means not fast-forwardable; fall back to PR
    if (e.status !== 409) throw e;
  }
}

// Core reaction: when sgc-production changes, do something
webhooks.on("push", async ({ payload }) => {
  switch (payload.ref) {
    case "refs/heads/sgc-production":
      if (!payload.deleted) await pushSgcProduction(payload);
      break;
    default:
      break;
  }
});

// Minimal Node server + webhook middleware
const server = http.createServer(async (req, res) => {
  return createNodeMiddleware(webhooks, { path: "/" })(req, res);
});

server.listen(Number(PORT), () => {
  console.log(`Webhook server listening on :${PORT}`);
});
