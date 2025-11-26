import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
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
 * Executes a command with real-time output streaming
 */
function execWithOutput(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      // Stream output to console in real-time
      process.stdout.write(output);
    });

    child.stderr?.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      // Stream errors to console in real-time
      process.stderr.write(output);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}\n${stderr}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Creates or updates a Shopify preview theme using Shopify CLI with Partners API token
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

    // Set up Shopify CLI authentication with Partners API token
    const partnersToken = process.env.SHOPIFY_CLI_TOKEN;
    if (!partnersToken) {
      throw new Error("SHOPIFY_CLI_TOKEN environment variable is not set");
    }

    // Define Shopify folders to push (exclude build files)
    const shopifyFolders = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
    const onlyArgs = shopifyFolders.flatMap(folder => ['--only', folder]);

    // Use node to run the Shopify CLI directly from node_modules
    const shopifyCliPath = `${process.cwd()}/node_modules/@shopify/cli/bin/shopify.js`;

    // Set up environment for Partners API authentication
    const shopifyEnv = {
      ...process.env,
      SHOPIFY_CLI_PARTNERS_TOKEN: partnersToken,
      // Also set as SHOPIFY_CLI_TOKEN for compatibility
      SHOPIFY_CLI_TOKEN: partnersToken,
      // Set npm cache to temp directory
      NPM_CONFIG_CACHE: '/tmp/.npm',
      HOME: '/tmp',
    };

    let themeId: string;
    let themeUrl: string;

    if (existingThemeId) {
      // Update existing preview theme
      console.log(`[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`);
      const args = [
        'theme',
        'push',
        '--theme', existingThemeId,
        '--store', storeName,
        ...onlyArgs
      ];

      console.log(`[${owner}/${repo}] Running: node ${shopifyCliPath} ${args.join(' ')}`);
      const stdout = await execWithOutput('node', [shopifyCliPath, ...args], { cwd: tempDir, env: shopifyEnv });

      themeId = existingThemeId;
      // Extract theme URL from output if available
      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
      themeUrl = urlMatch ? urlMatch[0] : `https://${storeName}.myshopify.com/admin/themes/${themeId}`;

      console.log(`[${owner}/${repo}] Successfully updated preview theme ${themeId}`);
    } else {
      // Create new unpublished theme
      console.log(`[${owner}/${repo}] Creating new preview theme...`);
      const args = [
        'theme',
        'push',
        '--unpublished',
        '--store', storeName,
        ...onlyArgs
      ];

      console.log(`[${owner}/${repo}] Running: node ${shopifyCliPath} ${args.join(' ')}`);
      const stdout = await execWithOutput('node', [shopifyCliPath, ...args], { cwd: tempDir, env: shopifyEnv });

      // Extract theme ID from output
      // Shopify CLI typically outputs: "Theme ID: 123456789" or similar
      const idMatch = stdout.match(/[Tt]heme\s+[Ii][Dd]:\s*(\d+)/) || 
                     stdout.match(/[Tt]heme\s+(\d+)/) ||
                     stdout.match(/id[:\s]+(\d+)/i);

      if (!idMatch || !idMatch[1]) {
        // Try to extract from any URL in the output
        const urlMatch = stdout.match(/themes\/(\d+)/);
        if (urlMatch && urlMatch[1]) {
          themeId = urlMatch[1];
        } else {
          throw new Error(`Could not extract theme ID from Shopify CLI output. Output: ${stdout.substring(0, 500)}`);
        }
      } else {
        themeId = idMatch[1];
      }

      const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
      themeUrl = urlMatch ? urlMatch[0] : `https://${storeName}.myshopify.com/admin/themes/${themeId}`;

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