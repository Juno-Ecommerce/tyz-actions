export async function updateStagingOnProductionPush(octokit: any, owner: string, repo: string) {
  try {
    // Check if staging branch exists
    let stagingExists = false;
    try {
      await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/staging", {
        owner,
        repo
      });
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
    const productionRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/production", {
      owner,
      repo
    });

    const productionSha = productionRef.data.object.sha;

    // Get the latest commit SHA from staging branch
    const stagingRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/staging", {
      owner,
      repo
    });

    const stagingSha = stagingRef.data.object.sha;

    // Check if staging is already up to date with production
    if (stagingSha === productionSha) {
      console.log(`[${owner}/${repo}] Staging is already up to date with production`);
      return;
    }

    // Get the merge base between staging and production to find the common ancestor
    const mergeBase = await octokit.request("GET /repos/{owner}/{repo}/compare/{base}...{head}", {
      owner,
      repo,
      base: "production",
      head: "staging"
    });

    const mergeBaseSha = mergeBase.data.merge_base_commit.sha;

    // If staging is already based on production (no unique commits), just fast-forward
    if (mergeBaseSha === productionSha) {
      console.log(`[${owner}/${repo}] Staging has no unique commits, fast-forwarding to production`);
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/staging", {
        owner,
        repo,
        sha: productionSha
      });
      return;
    }

    // Get commits that are in staging but not in production
    const stagingCommits = mergeBase.data.commits.reverse(); // Reverse to get chronological order

    console.log(`[${owner}/${repo}] Found ${stagingCommits.length} commits to rebase`);

    if (stagingCommits.length === 0) {
      console.log(`[${owner}/${repo}] No commits to rebase, staging is already up to date`);
      return;
    }

    // Start the rebase from production
    let currentParentSha = productionSha;

    // Replay each staging commit on top of production
    for (const commit of stagingCommits) {
      const commitDetails = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: commit.sha
      });

      // Create a new commit with the same message and tree, but with the new parent
      const rebasedCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: commitDetails.data.message,
        tree: commitDetails.data.tree.sha,
        parents: [currentParentSha]
      });

      currentParentSha = rebasedCommit.data.sha;
      console.log(`[${owner}/${repo}] Rebased commit: ${commit.sha.slice(0, 7)} -> ${currentParentSha.slice(0, 7)}`);
    }

    // Force update the staging branch to point to the last rebased commit
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/staging", {
      owner,
      repo,
      sha: currentParentSha,
      force: true // Force update to allow non-fast-forward updates (required for rebase)
    });

    console.log(`[${owner}/${repo}] Successfully rebased ${stagingCommits.length} commits from staging onto production`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error rebasing staging onto production:`, error.message);
    throw error; 
  }
}
