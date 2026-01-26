import { rateLimitedRequest, batchProcess } from "../utils/rate-limited-request.js";

export async function updateParentOnSGCPush(octokit: any, owner: string, repo: string, parent: "production" | "staging") {
  const disableStagingJSONSync = false;

  try {
    // Get the latest commit SHA from sgc branch
    const sgcRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/sgc-${parent}`, { owner, repo }),
      { owner, repo, operation: `get sgc-${parent} ref` }
    );

    const sgcSha = sgcRef.data.object.sha;

    // Get the current parent branch SHA
    const parentRef = await rateLimitedRequest(
      () => octokit.request(`GET /repos/{owner}/{repo}/git/ref/heads/${parent}`, { owner, repo }),
      { owner, repo, operation: `get ${parent} ref` }
    );

    const parentSha = parentRef.data.object.sha;

    // Get the tree of sgc branch to find all files
    const sgcTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: sgcSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get sgc-${parent} tree` }
    );

    // Filter for files, excluding specified files
    const sgcFiles = sgcTree.data.tree.filter((item: any) => {
      if (item.type !== "blob") return false;

      // If parent is staging, exclude JSON files except for settings_schema.json
      if (parent === "staging" && disableStagingJSONSync) {
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
    const parentTree = await rateLimitedRequest(
      () => octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: parentSha,
        recursive: "true"
      }),
      { owner, repo, operation: `get ${parent} tree` }
    );

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

    // Create a map of existing files in parent by path
    const parentFiles = new Map();
    // Create a set of all blob SHAs that exist in parent (for reuse)
    const parentBlobShas = new Set<string>();
    parentTree.data.tree.forEach((item: any) => {
      if (item.type === "blob") {
        parentFiles.set(item.path, item.sha);
        parentBlobShas.add(item.sha);
      }
    });

    // Create a set of sgc file paths for deletion detection
    const sgcFilePaths = new Set(sgcFiles.map((f: any) => f.path));

    // Prepare tree updates
    const treeUpdates: any[] = [];
    let filesUpdated = 0;
    let filesAdded = 0;
    let filesDeleted = 0;
    // Track which blob SHAs we need to fetch (only for blobs that don't exist in target)
    const blobsToFetch = new Map<string, any>();

    for (const sgcFile of sgcFiles) {
      // Only process files in Shopify folders (to match deletion logic)
      const isInShopifyFolder = shopifyFolders.some(folder => 
        sgcFile.path.startsWith(folder + '/') || sgcFile.path === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders
      }

      // Check if this file exists in parent
      if (parentFiles.has(sgcFile.path)) {
        // Check if the file content is different
        const parentFileSha = parentFiles.get(sgcFile.path);
        if (parentFileSha === sgcFile.sha) {
          // File is already up to date, skipping
          continue;
        }
      }

      // If the blob SHA already exists in parent, we can reuse it (no API calls needed!)
      if (parentBlobShas.has(sgcFile.sha)) {
        // Blob already exists in target, just reference it
        treeUpdates.push({
          path: sgcFile.path,
          mode: sgcFile.mode,
          type: "blob",
          sha: sgcFile.sha
        });

        if (parentFiles.has(sgcFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${sgcFile.path} (reused existing blob)`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${sgcFile.path} (reused existing blob)`);
        }
      } else {
        // Blob doesn't exist in target, we need to fetch and create it
        // Batch these for later to minimize API calls
        blobsToFetch.set(sgcFile.sha, sgcFile);
      }
    }

    // Fetch and create blobs only for files that need new blobs
    // Process in batches with rate limiting
    const blobEntries = Array.from(blobsToFetch.entries());
    await batchProcess(
      blobEntries,
      async ([blobSha, sgcFile]) => {
        // Get the blob content from sgc
        const blob = await rateLimitedRequest(
          () => octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            owner,
            repo,
            file_sha: blobSha
          }),
          { owner, repo, operation: `get blob ${sgcFile.path}` }
        );

        // Create a new blob in parent with the content from sgc
        const newBlob = await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content: blob.data.content,
            encoding: blob.data.encoding
          }),
          { owner, repo, operation: `create blob ${sgcFile.path}` }
        );

        // Add to tree updates
        treeUpdates.push({
          path: sgcFile.path,
          mode: sgcFile.mode,
          type: "blob",
          sha: newBlob.data.sha
        });

        if (parentFiles.has(sgcFile.path)) {
          filesUpdated++;
          console.log(`[${owner}/${repo}] Updated ${sgcFile.path}`);
        } else {
          filesAdded++;
          console.log(`[${owner}/${repo}] Added ${sgcFile.path}`);
        }
      },
      { owner, repo, batchSize: 10, delayBetweenBatches: 500, delayBetweenItems: 75 }
    );

    // Handle deletions: files that exist in parent but not in sgc (only in Shopify folders)
    for (const [filePath, _fileSha] of parentFiles.entries()) {
      // Only delete files within Shopify folders
      const isInShopifyFolder = shopifyFolders.some(folder => 
        filePath.startsWith(folder + '/') || filePath === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders (e.g., build system files)
      }

      // Skip if this file is excluded by the filtering logic (for staging)
      if (parent === "staging" && disableStagingJSONSync) {
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
    const newTree = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: parentSha,
        tree: treeUpdates
      }),
      { owner, repo, operation: "create tree" }
    );

    // Create commit message
    const commitParts: string[] = [];
    if (filesAdded > 0) {
      commitParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      commitParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      commitParts.push(`${filesDeleted} deleted`);
    }
    const commitMessage = `Sync files from sgc-${parent} (${commitParts.join(', ')})`;

    // Create a new commit
    const newCommit = await rateLimitedRequest(
      () => octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: commitMessage,
        tree: newTree.data.sha,
        parents: [parentSha]
      }),
      { owner, repo, operation: "create commit" }
    );

    // Update the parent branch to point to the new commit
    await rateLimitedRequest(
      () => octokit.request(`PATCH /repos/{owner}/{repo}/git/refs/heads/${parent}`, {
        owner,
        repo,
        sha: newCommit.data.sha
      }),
      { owner, repo, operation: `update ${parent} ref` }
    );

    const syncParts: string[] = [];
    if (filesAdded > 0) {
      syncParts.push(`${filesAdded} added`);
    }
    if (filesUpdated > 0) {
      syncParts.push(`${filesUpdated} updated`);
    }
    if (filesDeleted > 0) {
      syncParts.push(`${filesDeleted} deleted`);
    }
    const totalFiles = filesAdded + filesUpdated + filesDeleted;
    console.log(`[${owner}/${repo}] Successfully synced ${totalFiles} files from sgc-${parent} to ${parent} (${syncParts.join(', ')})`);

  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error syncing files from sgc-${parent}:`, error.message);

    // If sync fails, try a simpler approach - create a merge commit
    if (error.status === 422 || error.message.includes('conflict')) {
      try {
        await rateLimitedRequest(
          () => octokit.request("POST /repos/{owner}/{repo}/merges", {
            owner,
            repo,
            base: parent,
            head: `sgc-${parent}`,
            commit_message: `Merge sgc-${parent} into ${parent}`
          }),
          { owner, repo, operation: "fallback merge" }
        );
        console.log(`[${owner}/${repo}] Fallback: merged sgc-${parent} into ${parent}`);
      } catch (mergeError: any) {
        console.error(`[${owner}/${repo}] Fallback merge also failed:`, mergeError.message);
      }
    }
  }
}