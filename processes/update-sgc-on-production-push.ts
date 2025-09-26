export async function updateSGCOnProductionPush(octokit: any, owner: string, repo: string, includeJsonFiles: boolean = false) {
  try {
    // Get the latest commit SHA from production branch
    const productionRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/production", {
      owner,
      repo
    });

    const productionSha = productionRef.data.object.sha;

    // Get the latest commit SHA from sgc-production branch
    const sgcProductionRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/sgc-production", {
      owner,
      repo
    });

    const sgcProductionSha = sgcProductionRef.data.object.sha;

    // Get the production tree to find Shopify-specific folders
    const productionTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: productionSha,
      recursive: "true"
    });

    // Define the specific Shopify folders to sync
    const shopifyFolders = [
      'assets',
      'blocks', 
      'config',
      'layout',
      'locales',
      'sections',
      'snippets',
      'templates'
    ];

    // Filter for files in the specified Shopify folders, excluding JSON files
    const shopifyFiles = productionTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // Check if file is in one of the specified folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        item.path.startsWith(folder + '/') || item.path === folder
      );

      // Conditionally exclude JSON files based on parameter
      const isNotJson = includeJsonFiles || !item.path.endsWith('.json');

      return isInShopifyFolder && isNotJson;
    });

    console.log(`[${owner}/${repo}] Found ${shopifyFiles.length} Shopify files in production to sync`);

    if (shopifyFiles.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files found in production to sync`);
      return;
    }

    // Get the current sgc-production tree
    const sgcProductionTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: sgcProductionSha,
      recursive: "true"
    });

    // Create a map of existing files in sgc-production
    const sgcProductionFiles = new Map();
    sgcProductionTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        sgcProductionFiles.set(item.path, item.sha);
      }
    });

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesAdded = 0;

    for (const shopifyFile of shopifyFiles) {
      // Check if this file exists in sgc-production
      if (sgcProductionFiles.has(shopifyFile.path)) {
        // Check if the file content is different
        const sgcFileSha = sgcProductionFiles.get(shopifyFile.path);
        if (sgcFileSha === shopifyFile.sha) {
          console.log(`[${owner}/${repo}] File ${shopifyFile.path} is already up to date, skipping`);
          continue;
        }
      }

      // Get the blob content from production
      const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: shopifyFile.sha
      });

      // Create a new blob in sgc-production with the content from production
      const newBlob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: blob.data.content,
        encoding: blob.data.encoding
      });

      // Add to tree updates
      treeUpdates.push({
        path: shopifyFile.path,
        mode: shopifyFile.mode,
        type: "blob",
        sha: newBlob.data.sha
      });

      if (sgcProductionFiles.has(shopifyFile.path)) {
        filesUpdated++;
        console.log(`[${owner}/${repo}] Updated ${shopifyFile.path}`);
      } else {
        filesAdded++;
        console.log(`[${owner}/${repo}] Added ${shopifyFile.path}`);
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files to update in sgc-production`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: sgcProductionSha,
      tree: treeUpdates
    });

    // Create a new commit
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: `Sync Shopify files from production (${filesAdded} added, ${filesUpdated} updated)`,
      tree: newTree.data.sha,
      parents: [sgcProductionSha]
    });

    // Update the sgc-production branch to point to the new commit
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/heads/sgc-production", {
      owner,
      repo,
      sha: newCommit.data.sha
    });

    console.log(`[${owner}/${repo}] Successfully synced ${filesAdded + filesUpdated} Shopify files from production to sgc-production (${filesAdded} added, ${filesUpdated} updated)`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing Shopify files from production:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/merges", {
          owner,
          repo,
          base: "sgc-production",
          head: "production",
          commit_message: "Merge production into sgc-production (fallback from Shopify sync)"
        });
        console.log(`[${owner}/${repo}] Fallback: merged production into sgc-production`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}
