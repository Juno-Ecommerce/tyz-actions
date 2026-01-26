import { rateLimitedRequest } from "../utils/rate-limited-request.js";

export async function updateStagingOnProductionPush(octokit: any, owner: string, repo: string) {
  try {
    // Check if staging branch exists
    let stagingExists = false;
    try {
      await rateLimitedRequest(
        () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/staging", { owner, repo }),
        { owner, repo, operation: "check staging branch" }
      );
      stagingExists = true;
      console.log(`[${owner}/${repo}] ✅ Staging branch exists`);
    } catch (error: any) {
      if (error.status === 404) {
        console.log(`[${owner}/${repo}] ❌ Staging branch does not exist`);
        return;
      }
      throw error;
    }

    if (!stagingExists) {
      return;
    }

    // Get the latest commit SHA from production branch
    const productionRef = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/production", { owner, repo }),
      { owner, repo, operation: "get production ref" }
    );

    const productionSha = productionRef.data.object.sha;

    // Get the latest commit SHA from staging branch
    const stagingRef = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/staging", { owner, repo }),
      { owner, repo, operation: "get staging ref" }
    );

    const stagingSha = stagingRef.data.object.sha;

    // Check if staging is already up to date with production
    if (stagingSha === productionSha) {
      console.log(`[${owner}/${repo}] Staging is already up to date with production`);
      return;
    }

    // Get the production commit to get its tree SHA
    const productionCommit = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: productionSha
      }),
      { owner, repo, operation: "get production commit" }
    );

    // Create a new commit that rebases staging onto production
    // This creates a commit with production's tree and production as the parent (proper rebase)
    const rebaseCommit = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: `Rebase staging onto production (${productionSha.slice(0, 7)})`,
        tree: productionCommit.data.tree.sha, // Use production's tree SHA
        parents: [productionSha] // Use production as parent (proper rebase)
      }),
      { owner, repo, operation: "create rebase commit" }
    );

    // Force update the staging branch to point to the new rebase commit
    await rateLimitedRequest(
      () => octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/staging", {
        owner,
        repo,
        sha: rebaseCommit.data.sha,
        force: true // Force update to allow non-fast-forward updates (required for rebase)
      }),
      { owner, repo, operation: "update staging ref" }
    );

    console.log(`[${owner}/${repo}] Successfully rebased staging onto production`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error rebasing staging onto production:`, error.message);
    throw error; 
  }
}
