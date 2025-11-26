import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync } from "node:fs";

const execAsync = promisify(exec);

/**
 * Extracts the store name from a Shopify admin URL in the repo homepage
 * Example: "https://admin.shopify.com/store/store-name" -> "store-name"
 */
function extractStoreNameFromHomepage(homepage: string | null): string | null {
  if (!homepage) return null;

  // Match Shopify admin URLs
  const match = homepage.match(/https?:\/\/admin\.shopify\.com\/store\/([a-zA-Z0-9-]+)/i);
  if (match && match[1]) {
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

    // Extract the archive
    console.log(`[${owner}/${repo}] Extracting archive...`);
    await execAsync(`cd ${tempDir} && tar -xzf archive.tar.gz --strip-components=1`);
    
    // Clean up archive file
    await execAsync(`rm -f ${archivePath}`).catch(() => {
      // Ignore cleanup errors
    });
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error downloading repository archive:`, error.message);
    throw error;
  }
}

/**
 * Creates or updates a Shopify preview theme using Shopify CLI
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

    // Set up Shopify CLI authentication (you may need to adjust this based on your auth setup)
    // For now, assuming SHOPIFY_CLI_TOKEN is set in environment
    const shopifyToken = process.env.SHOPIFY_CLI_TOKEN;
    if (!shopifyToken) {
      throw new Error("SHOPIFY_CLI_TOKEN environment variable is not set");
    }

    let themeId: string;
    let themeUrl: string;

    // Define Shopify folders to push (exclude build files)
    const shopifyFolders = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
    const onlyFlag = shopifyFolders.map(folder => `--only ${folder}`).join(' ');

    if (existingThemeId) {
      // Update existing preview theme
      console.log(`[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`);
      const { stdout } = await execAsync(
        `cd ${tempDir} && shopify theme push --theme ${existingThemeId} --store ${storeName} ${onlyFlag}`,
        { env: { ...process.env, SHOPIFY_CLI_TOKEN: shopifyToken } }
      );

      themeId = existingThemeId;
      // Extract theme URL from output if available
      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
      themeUrl = urlMatch ? urlMatch[0] : `https://${storeName}.myshopify.com/admin/themes/${themeId}`;

      console.log(`[${owner}/${repo}] Successfully updated preview theme ${themeId}`);
    } else {
      // Create new unpublished theme
      console.log(`[${owner}/${repo}] Creating new preview theme...`);
      const { stdout } = await execAsync(
        `cd ${tempDir} && shopify theme push --unpublished --store ${storeName} ${onlyFlag}`,
        { env: { ...process.env, SHOPIFY_CLI_TOKEN: shopifyToken } }
      );

      // Extract theme ID from output
      // Shopify CLI typically outputs: "Theme ID: 123456789" or similar
      const idMatch = stdout.match(/[Tt]heme\s+[Ii][Dd]:\s*(\d+)/) || stdout.match(/[Tt]heme\s+(\d+)/);
      if (!idMatch || !idMatch[1]) {
        throw new Error("Could not extract theme ID from Shopify CLI output");
      }

      themeId = idMatch[1];
      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
      themeUrl = urlMatch ? urlMatch[0] : `https://${storeName}.myshopify.com/admin/themes/${themeId}`;

      console.log(`[${owner}/${repo}] Successfully created preview theme ${themeId}`);

      // Comment the theme ID on the PR for future updates
      await commentPreviewThemeId(octokit, owner, repo, prNumber, themeId);
    }

    // Clean up temporary directory
    await execAsync(`rm -rf ${tempDir}`).catch(() => {
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