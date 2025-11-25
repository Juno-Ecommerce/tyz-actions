export async function updateParentOnSGCPush(octokit: any, owner: string, repo: string, parent: "production" | "staging") {
  try {
    // Get the latest commit SHA from sgc branch
    const sgcRef = await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/sgc-${parent}`, {
      owner,
      repo
    });

    const sgcSha = sgcRef.data.object.sha;

    // Get the current parent branch SHA
    const parentRef = await octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${parent}`, {
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
    const sgcFiles = sgcTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // If parent is staging, exclude JSON files except for settings_schema.json
      if (parent === "staging") {
        const isJsonFile = item.path.endsWith('.json');
        const isSettingsSchema = item.path === 'config/settings_schema.json';
        return !isJsonFile || isSettingsSchema;
      }

      return true;
    });

    console.log(`[${owner}/${repo}] Found ${sgcFiles.length} files in sgc-${parent}`);

    if (sgcFiles.length === 0) {
      console.log(`[${owner}/${repo}] No files found in sgc-${parent}`);
      return;
    }

    // Get the current parent tree
    const parentTree = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: parentSha,
      recursive: "true"
    });

    // Define the specific Shopify folders where deletions are allowed
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

    // Create a map of existing files in parent
    const parentFiles = new Map();
    parentTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        parentFiles.set(item.path, item.sha);
      }
    });

    // Create a set of sgc file paths for deletion detection
    const sgcFilePaths = new Set(sgcFiles.map((f: any) => f.path));

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesDeleted = 0;

    for (const sgcFile of sgcFiles) {
      // Check if this file exists in parent
      if (parentFiles.has(sgcFile.path)) {
        // Check if the file content is different
        const parentFileSha = parentFiles.get(sgcFile.path);
        if (parentFileSha === sgcFile.sha) {
          // File is already up to date, skipping
          continue;
        }

        // Get the blob content from sgc
        const blob = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: sgcFile.sha
        });

        // Create a new blob in parent with the content from sgc
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
        console.log(`[${owner}/${repo}] File ${sgcFile.path} not found in ${parent}, skipping`);
      }
    }

    // Handle deletions: files that exist in parent but not in sgc (only in Shopify folders)
    for (const [filePath, fileSha] of parentFiles.entries()) {
      // Only delete files within Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders (e.g., build system files)
      }

      // Skip if this file is excluded by the filtering logic (for staging)
      if (parent === "staging") {
        const isJsonFile = filePath.endsWith('.json');
        const isSettingsSchema = filePath === 'config/settings_schema.json';
        if (isJsonFile && !isSettingsSchema) {
          continue; // Skip JSON files in staging (except settings_schema.json)
        }
      }

      // If file exists in parent but not in sgc, mark for deletion
      if (!sgcFilePaths.has(filePath)) {
        treeUpdates.push({
          path: filePath,
          mode: "100644", // Standard file mode
          type: "blob",
          sha: null // Setting sha to null deletes the file
        });
        filesDeleted++;
        console.log(`[${owner}/${repo}] Deleted ${filePath} (not in sgc-${parent})`);
      }
    }

    if (treeUpdates.length === 0) {
      console.log(`[${owner}/${repo}] No files to update in ${parent}`);
      return;
    }

    // Create a new tree with the updated files
    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: parentSha,
      tree: treeUpdates
    });

    // Create commit message
    const commitParts: string[] = [];
    if (filesUpdated > 0) {
      commitParts.push(`${filesUpdated} file${filesUpdated !== 1 ? 's' : ''} updated`);
    }
    if (filesDeleted > 0) {
      commitParts.push(`${filesDeleted} file${filesDeleted !== 1 ? 's' : ''} deleted`);
    }
    const commitMessage = `Sync files from sgc-${parent} (${commitParts.join(', ')})`;

    // Create a new commit
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: commitMessage,
      tree: newTree.data.sha,
      parents: [parentSha]
    });

    // Update the parent branch to point to the new commit
    await octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/${parent}`, {
      owner,
      repo,
      sha: newCommit.data.sha
    });

    const syncParts: string[] = [];
    if (filesUpdated > 0) {
      syncParts.push(`${filesUpdated} file${filesUpdated !== 1 ? 's' : ''} updated`);
    }
    if (filesDeleted > 0) {
      syncParts.push(`${filesDeleted} file${filesDeleted !== 1 ? 's' : ''} deleted`);
    }
    console.log(`[${owner}/${repo}] Successfully synced ${syncParts.join(' and ')} from sgc-${parent} to ${parent}`);

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