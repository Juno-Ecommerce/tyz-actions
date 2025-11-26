import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";

/**
 * Extracts the store name from a Shopify admin URL in the repo homepage
 * Example: "https://admin.shopify.com/store/store-name" -> "store-name"
 */
function extractStoreNameFromHomepage(homepage: string | null): string | null {
  if (!homepage) return null;

  // Match Shopify admin URLs
  const match = homepage.match(/https?:\/\/admin\.shopify\.com\/store\/([a-zA-Z0-9-]+)/i);
  if (match && match[1]) {
    console.log(`Extracted store name from homepage: ${match[1]}`);
    return match[1];
  }

  return null;
}

/**
 * Checks PR comments for an existing preview theme ID
 * Looks for a comment with pattern: "Preview Theme ID: <id>"
 */
async function getExistingPreviewThemeId(octokit: any, owner: string, repo: string, prNumber: number): Promise<string | null> {
  try {
    const { data: comments } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: prNumber
    });

    // Look for a comment containing "Preview Theme ID:"
    for (const comment of comments) {
      const match = comment.body?.match(/Preview Theme ID:\s*(\d+)/i);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error checking for existing preview theme:`, error.message);
    return null;
  }
}

/**
 * Creates a comment on the PR with the preview theme ID
 */
async function commentPreviewThemeId(octokit: any, owner: string, repo: string, prNumber: number, themeId: string): Promise<void> {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: prNumber,
      body: `🎨 Preview Theme ID: ${themeId}\n\nThis theme will be updated automatically when you push changes to this PR.`
    });
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error commenting theme ID:`, error.message);
  }
}

/**
 * Downloads and extracts a repository archive to a temporary directory
 */
async function downloadRepositoryArchive(
  octokit: any,
  owner: string,
  repo: string,
  ref: string,
  tempDir: string
): Promise<void> {
  try {
    // Create temp directory
    mkdirSync(tempDir, { recursive: true });

    // Download the archive using GitHub API
    console.log(`[${owner}/${repo}] Downloading repository archive for ref: ${ref}...`);
    const { data: archive } = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner,
      repo,
      ref,
      request: {
        responseType: "arraybuffer"
      }
    });

    // Write archive to file
    const archivePath = `${tempDir}/archive.tar.gz`;
    const buffer = Buffer.from(archive as ArrayBuffer);
    const writeStream = createWriteStream(archivePath);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
      writeStream.write(buffer);
      writeStream.end();
    });

    // Extract the archive using tar package
    console.log(`[${owner}/${repo}] Extracting archive...`);
    await tar.extract({
      file: archivePath,
      cwd: tempDir,
      strip: 1
    });

    // Clean up archive file
    const { unlink } = await import("node:fs/promises");
    await unlink(archivePath).catch(() => {
      // Ignore cleanup errors
    });
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error downloading repository archive:`, error.message);
    throw error;
  }
}

/**
 * Recursively gets all files in Shopify folders
 */
function getShopifyFiles(dir: string, baseDir: string = dir, shopifyFolders: string[]): Array<{ path: string; content: Buffer }> {
  const files: Array<{ path: string; content: Buffer }> = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = fullPath.replace(baseDir + '/', '');
      const stat = statSync(fullPath);

      // Check if this file is in a Shopify folder
      const isInShopifyFolder = shopifyFolders.some(folder => 
        relativePath.startsWith(folder + '/') || relativePath === folder
      );

      if (!isInShopifyFolder) {
        continue; // Skip files outside Shopify folders
      }

      if (stat.isDirectory()) {
        // Recursively get files from subdirectories
        files.push(...getShopifyFiles(fullPath, baseDir, shopifyFolders));
      } else if (stat.isFile()) {
        // Read file content
        const content = readFileSync(fullPath);
        files.push({ path: relativePath, content });
      }
    }
  } catch (error) {
    // Ignore errors reading directories
  }

  return files;
}

/**
 * Creates or updates a Shopify preview theme using Admin API
 */
async function createOrUpdatePreviewTheme(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  prHeadRef: string,
  storeName: string,
  existingThemeId: string | null
): Promise<void> {
  try {
    // Create a temporary directory
    const tempDir = `/tmp/preview-${owner}-${repo}-${prNumber}-${Date.now()}`;

    console.log(`[${owner}/${repo}] Downloading repository to ${tempDir}...`);
    await downloadRepositoryArchive(octokit, owner, repo, prHeadRef, tempDir);

    // Set up Shopify Admin API authentication
    const shopifyToken = process.env.SHOPIFY_CLI_TOKEN;
    if (!shopifyToken) {
      throw new Error("SHOPIFY_CLI_TOKEN environment variable is not set");
    }

    // Define Shopify folders to push (exclude build files)
    const shopifyFolders = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];

    // Get all files from Shopify folders
    console.log(`[${owner}/${repo}] Reading Shopify theme files...`);
    const themeFiles = getShopifyFiles(tempDir, tempDir, shopifyFolders);
    console.log(`[${owner}/${repo}] Found ${themeFiles.length} theme files to upload`);

    const adminApiUrl = `https://${storeName}.myshopify.com/admin/api/2024-01`;
    let themeId: string;
    let themeUrl: string;

    if (existingThemeId) {
      // Update existing preview theme
      console.log(`[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`);
      themeId = existingThemeId;

      // Upload files to existing theme
      for (const file of themeFiles) {
        try {
          const response = await fetch(`${adminApiUrl}/themes/${themeId}/assets.json`, {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              asset: {
                key: file.path,
                value: file.content.toString('utf8'),
              }
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[${owner}/${repo}] Failed to update ${file.path}: ${errorText}`);
          }
        } catch (error: any) {
          console.warn(`[${owner}/${repo}] Error updating ${file.path}:`, error.message);
        }
      }

      themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
      console.log(`[${owner}/${repo}] Successfully updated preview theme ${themeId}`);
    } else {
      // Create new unpublished theme
      console.log(`[${owner}/${repo}] Creating new preview theme...`);

      // Create the theme
      const createResponse = await fetch(`${adminApiUrl}/themes.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': shopifyToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          theme: {
            name: `Preview - PR #${prNumber}`,
            role: 'development' // Unpublished theme
          }
        })
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create theme: ${errorText}`);
      }

      const createData = await createResponse.json() as { theme: { id: number } };
      themeId = createData.theme.id.toString();

      // Upload files to the new theme
      console.log(`[${owner}/${repo}] Uploading ${themeFiles.length} files to theme...`);
      for (const file of themeFiles) {
        try {
          const response = await fetch(`${adminApiUrl}/themes/${themeId}/assets.json`, {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': shopifyToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              asset: {
                key: file.path,
                value: file.content.toString('utf8'),
              }
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[${owner}/${repo}] Failed to upload ${file.path}: ${errorText}`);
          }
        } catch (error: any) {
          console.warn(`[${owner}/${repo}] Error uploading ${file.path}:`, error.message);
        }
      }

      themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
      console.log(`[${owner}/${repo}] Successfully created preview theme ${themeId}`);

      // Comment the theme ID on the PR for future updates
      await commentPreviewThemeId(octokit, owner, repo, prNumber, themeId);
    }

    // Clean up temporary directory
    const { rm } = await import("node:fs/promises");
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // Ignore cleanup errors
    });

    console.log(`[${owner}/${repo}] Preview theme ready: ${themeUrl}`);
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error creating/updating preview theme:`, error.message);
    throw error;
  }
}

/**
 * Handles the preview label being added to a PR
 */
export async function handlePreviewTheme(
  octokit: any,
  owner: string,
  repo: string,
  pr: any
): Promise<void> {
  try {
    // Get repository data
    const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo
    });

    const storeName = extractStoreNameFromHomepage(repoData.homepage);
    if (!storeName) {
      console.error(`[${owner}/${repo}] Could not extract store name from repository homepage`);
      // Comment on PR about the issue
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: pr.number,
        body: "❌ Could not create preview theme. Please add a Shopify admin URL to the repository homepage (e.g., `https://admin.shopify.com/store/your-store-name`)."
      });
      return;
    }

    // Check if a preview theme already exists for this PR
    const existingThemeId = await getExistingPreviewThemeId(octokit, owner, repo, pr.number);

    // Create or update the preview theme
    await createOrUpdatePreviewTheme(
      octokit,
      owner,
      repo,
      pr.number,
      pr.head.ref,
      storeName,
      existingThemeId
    );
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error handling preview label:`, error.message);
    // Comment on PR about the error
    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: pr.number,
        body: `❌ Error creating preview theme: ${error.message}`
      });
    } catch (commentError) {
      // Ignore comment errors
    }
  }
}