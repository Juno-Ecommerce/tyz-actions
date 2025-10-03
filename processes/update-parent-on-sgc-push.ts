export async function updateParentOnSGCPush(octokit: any, owner: string, repo: string, parent: "production" | "staging") {
  try {
    // Get the latest commit SHA from sgc branch
    const sgcRef = await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/sgc-${parent}`, {
      owner,
      repo
    });

    const sgcSha = sgcRef.data.object.sha;

    // Get the current parent branch SHA
    const parentRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/production", {
      owner,
      repo
    });

    const parentSha = parentRef.data.object.sha;

    // Get the tree of sgc branch to find all files
    const sgcTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: sgcSha,
      recursive: "true"
    });

    // Filter for files, excluding specified files
    const sgcFiles = sgcTree.data.tree.filter((item: any) => item.type === "blob");

    console.log(`[${owner}/${repo}] Found ${sgcFiles.length} files in sgc-${parent}`);

    if (sgcFiles.length === 0) {
      console.log(`[${owner}/${repo}] No files found in sgc-${parent}`);
      return;
    }

    // Get the current production tree
    const parentTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: parentSha,
      recursive: "true"
    });

    // Create a map of existing files in production
    const parentFiles = new Map();
    parentTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        parentFiles.set(item.path, item.sha);
      }
    });

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;

    for (const sgcFile of sgcFiles) {
      // Check if this file exists in production
      if (parentFiles.has(sgcFile.path)) {
        // Check if the file content is different
        const productionFileSha = parentFiles.get(sgcFile.path);
        if (productionFileSha === sgcFile.sha) {
          // File is already up to date, skipping
          continue;
        }

        // Get the blob content from sgc
        const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: sgcFile.sha
        });

        // Create a new blob in production with the content from sgc
        const newBlob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content: blob.data.content,
          encoding: blob.data.encoding
        });

        // Add to tree updates
        treeUpdates.push({
          path: sgcFile.path,
          mode: sgcFile.mode,
          type: "blob",
          sha: newBlob.data.sha
        });

        filesUpdated++;
        console.log(`[${owner}/${repo}] Updated ${sgcFile.path}`);
      } else {
        console.log(`[${owner}/${repo}] File ${sgcFile.path} not found in production, skipping`);
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No files to update in production`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: parentSha,
      tree: treeUpdates
    });

    // Create a new commit
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: `Sync files from sgc-${parent} (${filesUpdated} files updated)`,
      tree: newTree.data.sha,
      parents: [parentSha]
    });

    // Update the production branch to point to the new commit
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/production", {
      owner,
      repo,
      sha: newCommit.data.sha
    });

    console.log(`[${owner}/${repo}] Successfully synced ${filesUpdated} files from sgc-${parent} to production`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing files from sgc-${parent}:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/merges", {
          owner,
          repo,
          base: parent,
          head: `sgc-${parent}`,
          commit_message: `Merge sgc-${parent} into ${parent}`
        });
        console.log(`[${owner}/${repo}] Fallback: merged sgc-${parent} into ${parent}`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}