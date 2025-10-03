export async function updateSGCOnParentPush(octokit: any, owner: string, repo: string, includeJsonFiles: boolean = false, parent: "staging" | "production") {
  try {
    // Get the latest commit SHA from ${parent} branch
    const parentRef = await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${parent}`, {
      owner,
      repo
    });

    const parentSha = parentRef.data.object.sha;

    // Get the latest commit SHA from sgc-${parent} branch
    const sgcRef = await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/sgc-${parent}`, {
      owner,
      repo
    });

    const sgcSha = sgcRef.data.object.sha;

    // Get the parent tree to find Shopify-specific folders
    const parentTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: parentSha,
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
    const shopifyFiles = parentTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // Check if file is in one of the specified folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        item.path.startsWith(folder + '/') || item.path === folder
      );

      // Always include config/settings_schema.json regardless of JSON file filtering
      const isSettingsSchema = item.path === 'config/settings_schema.json';

      // Conditionally exclude JSON files based on parameter, but always include settings_schema.json
      const isNotJson = includeJsonFiles || !item.path.endsWith('.json') || isSettingsSchema;

      return isInShopifyFolder && isNotJson;
    });

    console.log(`[${owner}/${repo}] Found ${shopifyFiles.length} Shopify files in ${parent} to sync`);

    if (shopifyFiles.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files found in ${parent} to sync`);
      return;
    }

    // Get the current sgc-${parent} tree
    const sgcTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: sgcSha,
      recursive: "true"
    });

    // Create a map of existing files in sgc-${parent}
    const sgcFiles = new Map();
    sgcTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        sgcFiles.set(item.path, item.sha);
      }
    });

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesAdded = 0;

    for (const shopifyFile of shopifyFiles) {
      // Check if this file exists in sgc-${parent}
      if (sgcFiles.has(shopifyFile.path)) {
        // Check if the file content is different
        const sgcFileSha = sgcFiles.get(shopifyFile.path);
        if (sgcFileSha === shopifyFile.sha) {
          console.log(`[${owner}/${repo}] File ${shopifyFile.path} is already up to date, skipping`);
          continue;
        }
      }

      // Get the blob content from ${parent}
      const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: shopifyFile.sha
      });

      // Create a new blob in sgc-${parent} with the content from ${parent}
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

      if (sgcFiles.has(shopifyFile.path)) {
        filesUpdated++;
        console.log(`[${owner}/${repo}] Updated ${shopifyFile.path}`);
      } else {
        filesAdded++;
        console.log(`[${owner}/${repo}] Added ${shopifyFile.path}`);
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No Shopify files to update in sgc-${parent}`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: sgcSha,
      tree: treeUpdates
    });

    // Create a new commit
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: `Sync Shopify files from ${parent} (${filesAdded} added, ${filesUpdated} updated)`,
      tree: newTree.data.sha,
      parents: [sgcSha]
    });

    // Update the sgc-${parent} branch to point to the new commit
    await octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/sgc-${parent}`, {
      owner,
      repo,
      sha: newCommit.data.sha
    });

    console.log(`[${owner}/${repo}] Successfully synced ${filesAdded + filesUpdated} Shopify files from ${parent} to sgc-${parent} (${filesAdded} added, ${filesUpdated} updated)`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing Shopify files from ${parent}:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/merges", {
          owner,
          repo,
          base: `sgc-${parent}`,
          head: parent,
          commit_message: `Merge ${parent} into sgc-${parent} (fallback from Shopify sync)`
        });
        console.log(`[${owner}/${repo}] Fallback: merged ${parent} into sgc-${parent}`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}
