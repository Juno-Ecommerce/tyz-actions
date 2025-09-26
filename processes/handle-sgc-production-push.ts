export async function handleSgcProductionPush(octokit: any, owner: string, repo: string) {
  try {
    // Get the latest commit SHA from sgc-production branch
    const sgcProductionRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/sgc-production", {
      owner,
      repo
    });

    const sgcProductionSha = sgcProductionRef.data.object.sha;

    // Get the current production branch SHA
    const productionRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/production", {
      owner,
      repo
    });

    const productionSha = productionRef.data.object.sha;

    // Get the tree of sgc-production branch to find all JSON files
    const sgcProductionTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: sgcProductionSha,
      recursive: "true"
    });

    // Files to exclude from sync
    const excludedFiles = [
      'settings_schema.json'
    ];

    // Filter for JSON files, excluding specified files
    const jsonFiles = sgcProductionTree.data.tree.filter((item: any) =>
      item.type === "blob" && 
      item.path.endsWith('.json') &&
      !excludedFiles.some(excluded => item.path.endsWith(excluded))
    );

    console.log(`[${owner}/${repo}] Found ${jsonFiles.length} JSON files in sgc-production`);

    if (jsonFiles.length === 0) {
      console.log(`[${owner}/${repo}] No JSON files found in sgc-production`);
      return;
    }

    // Get the current production tree
    const productionTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: productionSha,
      recursive: "true"
    });

    // Create a map of existing files in production
    const productionFiles = new Map();
    productionTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        productionFiles.set(item.path, item.sha);
      }
    });

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;

    for (const jsonFile of jsonFiles) {
      // Check if this file exists in production
      if (productionFiles.has(jsonFile.path)) {
        // Check if the file content is different
        const productionFileSha = productionFiles.get(jsonFile.path);
        if (productionFileSha === jsonFile.sha) {
          console.log(`[${owner}/${repo}] File ${jsonFile.path} is already up to date, skipping`);
          continue;
        }

        // Get the blob content from sgc-production
        const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: jsonFile.sha
        });

        // Create a new blob in production with the content from sgc-production
        const newBlob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content: blob.data.content,
          encoding: blob.data.encoding
        });

        // Add to tree updates
        treeUpdates.push({
          path: jsonFile.path,
          mode: jsonFile.mode,
          type: "blob",
          sha: newBlob.data.sha
        });

        filesUpdated++;
        console.log(`[${owner}/${repo}] Updated ${jsonFile.path}`);
      } else {
        console.log(`[${owner}/${repo}] File ${jsonFile.path} not found in production, skipping`);
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No JSON files to update in production`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: productionSha,
      tree: treeUpdates
    });

    // Create a new commit
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: `Sync JSON files from sgc-production (${filesUpdated} files updated)`,
      tree: newTree.data.sha,
      parents: [productionSha]
    });

    // Update the production branch to point to the new commit
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/production", {
      owner,
      repo,
      sha: newCommit.data.sha
    });

    console.log(`[${owner}/${repo}] Successfully synced ${filesUpdated} JSON files from sgc-production to production`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing JSON files from sgc-production:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/merges", {
          owner,
          repo,
          base: "production",
          head: "sgc-production",
          commit_message: "Merge sgc-production into production (fallback from JSON sync)"
        });
        console.log(`[${owner}/${repo}] Fallback: merged sgc-production into production`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}