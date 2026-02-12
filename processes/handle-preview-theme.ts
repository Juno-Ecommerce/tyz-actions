import { Octokit } from "@octokit/core";
import { PullRequest } from "@octokit/webhooks-types";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const archiver = require("archiver");
const tar = require("tar");

/**
 * Formats the current date as DD/MM/YY
 */
function formatDateDDMMYY(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
}

/**
 * Delays execution for the specified number of milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if a theme is ready by querying its status via the public API
 */
async function isThemeReady(
  storeName: string,
  themeId: string,
  owner: string,
  repo: string
): Promise<boolean> {
  try {
    const apiUrl = "https://tyz-actions-access.vercel.app/api/theme/status";
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop: `${storeName}.myshopify.com`,
        themeId: themeId,
      }),
    });

    if (!response.ok) {
      return false;
    }

    const result = (await response.json()) as {
      processing: boolean | null;
      error?: string;
    };

    // If there's an error or theme is still processing, it's not ready
    if (result.error || result.processing === true) {
      return false;
    }

    // If processing is false or null (and no error), theme should be ready
    // Also check if we can access the preview URL to confirm it's fully processed
    const previewUrl = `https://${storeName}.myshopify.com?preview_theme_id=${themeId}`;

    try {
      const previewResponse = await fetch(previewUrl, {
        method: "HEAD",
        redirect: "follow",
      });
      // If we get a 200 or redirect, the theme is likely ready
      return previewResponse.ok || previewResponse.status < 400;
    } catch {
      // If preview check fails, assume theme is ready if API query succeeded
      return result.processing === false;
    }
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error checking theme status:`,
      error.message
    );
    return false;
  }
}

/**
 * Polls the theme status every 5 seconds until it's ready
 * Returns true when ready, false if timeout is reached
 */
async function waitForThemeReady(
  storeName: string,
  themeId: string,
  owner: string,
  repo: string,
  maxWaitTime: number = 5 * 60 * 1000 // 5 minutes max
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 5 * 1000; // 5 seconds

  console.log(
    `[${owner}/${repo}] Polling theme ${themeId} status every 5 seconds...`
  );

  while (Date.now() - startTime < maxWaitTime) {
    const isReady = await isThemeReady(storeName, themeId, owner, repo);

    if (isReady) {
      console.log(
        `[${owner}/${repo}] Theme ${themeId} is ready after ${Math.round(
          (Date.now() - startTime) / 1000
        )} seconds`
      );
      return true;
    }

    // Wait 5 seconds before next poll
    await delay(pollInterval);
  }

  console.warn(
    `[${owner}/${repo}] Theme ${themeId} did not become ready within ${
      maxWaitTime / 1000
    } seconds`
  );
  return false;
}

/**
 * Extracts the store name from a Shopify admin URL in the repo homepage
 * Example: "https://admin.shopify.com/store/store-name" -> "store-name"
 */
async function extractStoreNameFromHomepage(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest
): Promise<string | null> {
  const displayMissingStoreNameError = async () => {
    console.error(
      `[${owner}/${repo}] Could not extract store name from repository homepage`
    );

    // Comment on PR about the issue
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pr.number,
        body: "❌ Could not create preview theme. Please add a Shopify admin URL to the repository homepage (e.g., `https://admin.shopify.com/store/your-store-name`).",
      }
    );
  };

  // Get repository data
  const { data: repoData } = await octokit.request(
    "GET /repos/{owner}/{repo}",
    {
      owner,
      repo,
    }
  );

  if (!repoData.homepage) {
    await displayMissingStoreNameError();
    return null;
  }

  // Match Shopify admin URLs
  const match = repoData.homepage.match(
    /https?:\/\/admin\.shopify\.com\/store\/([a-zA-Z0-9-]+)/i
  );
  if (match && match[1]) {
    return match[1];
  }

  await displayMissingStoreNameError();
  return null;
}

/**
 * Checks PR description for an existing preview theme ID
 * Looks for pattern: "[preview-theme-id:<id>]" in the PR body
 */
async function getExistingPreviewThemeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string | null> {
  try {
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
      owner,
      repo,
        pull_number: prNumber,
      }
    );

    if (pr.body) {
      // Match the new format: [preview-theme-id:123456]
      const match = pr.body.match(/\[preview-theme-id:(\d+)\]/i);
      if (match && match[1]) {
        return match[1];
      }
      // Also support old formats for backwards compatibility
      const oldMatch1 = pr.body.match(/Preview Theme ID:\s*\[(\d+)\]/i);
      if (oldMatch1 && oldMatch1[1]) {
        return oldMatch1[1];
      }
      const oldMatch2 = pr.body.match(/Preview Theme ID:\s*(\d+)/i);
      if (oldMatch2 && oldMatch2[1]) {
        return oldMatch2[1];
      }
    }

    return null;
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error checking for existing preview theme:`,
      error.message
    );
    return null;
  }
}

/**
 * Saves the preview theme ID to the PR description with warnings
 */
async function saveThemeIdToDescription(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  themeId: string
): Promise<void> {
  try {
    // Get current PR to preserve existing description
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: prNumber,
      }
    );

    let updatedBody = pr.body || "";

    // Remove existing Preview Theme ID section if present
    // Match the warning block pattern (multiline)
    updatedBody = updatedBody.replace(
      /\n+\s*⚠️\s*WARNING:.*?\n.*?\[preview-theme-id:\d+\].*?\n.*?⚠️\s*Only remove.*?⚠️/gs,
      ""
    );
    // Also remove any old formats
    updatedBody = updatedBody.replace(/\[preview-theme-id:\d+\]/gi, "").trim();
    updatedBody = updatedBody
      .replace(/Preview Theme ID:\s*\[?\d+\]?/gi, "")
      .trim();

    // Add the Preview Theme ID with warnings and square brackets
    const themeIdSection = "\n\n\n\n\n\n⚠️ WARNING: DO NOT REMOVE ⚠️\n[preview-theme-id:" + themeId + "]\n⚠️ Only remove this if you want to create a new preview theme entirely ⚠️\n";

    // Append the theme ID section
    updatedBody += themeIdSection;

    // Update the PR description
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      body: updatedBody,
    });

    console.log(
      `[${owner}/${repo}] Saved theme ID ${themeId} to PR description`
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error saving theme ID to PR description:`,
      error.message
    );
  }
}

/**
 * Creates a comment on the PR with the preview theme ID
 */
async function commentPreviewThemeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  themeId: string,
  storeName: string,
  method: "create" | "update"
): Promise<void> {
  const createBody = "Preview theme successfully created!\n\nTheme URL: https://" + storeName + ".myshopify.com?preview_theme_id=" + themeId + "\nCustomiser URL: https://" + storeName + ".myshopify.com/admin/themes/" + themeId + "/editor\nCode URL: https://" + storeName + ".myshopify.com/admin/themes/" + themeId + "\n\nThis theme will be updated automatically when you push changes to this PR.\n\nThe theme ID has been saved into the PR description. Please only remove this id from your PR description if you want to create a new preview theme.";

  const updateBody = "Preview theme successfully updated!\n\nTheme URL: https://" + storeName + ".myshopify.com?preview_theme_id=" + themeId + "\nCustomiser URL: https://" + storeName + ".myshopify.com/admin/themes/" + themeId + "/editor\nCode URL: https://" + storeName + ".myshopify.com/admin/themes/" + themeId;

  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
      owner,
      repo,
      issue_number: prNumber,
        body: method === "create" ? createBody : updateBody,
      }
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error commenting theme ID:`,
      error.message
    );
  }
}

/**
 * Downloads and extracts a repository archive to a temporary directory
 */
async function downloadAndExtractRepository(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest,
  tempDir: string
): Promise<void> {
  try {
    console.log(`[${owner}/${repo}] Downloading repository to ${tempDir}...`);

    mkdirSync(tempDir, { recursive: true });

    console.log(
      `[${owner}/${repo}] Downloading repository archive for ref: ${pr.head.ref}...`
    );
    const { data: archive } = await octokit.request(
      "GET /repos/{owner}/{repo}/tarball/{ref}",
      {
        owner,
        repo,
        ref: pr.head.ref,
        request: {
          responseType: "arraybuffer",
        },
      }
    );

    const archivePath = `${tempDir}/archive.tar.gz`;
    console.log(`[${owner}/${repo}] Writing archive to ${archivePath}...`);
    const buffer = Buffer.from(archive as ArrayBuffer);
    const writeStream = createWriteStream(archivePath);
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", reject);
      writeStream.write(buffer);
      writeStream.end();
    });

    console.log(`[${owner}/${repo}] Extracting archive...`);
    await tar.extract({
      file: archivePath,
      cwd: tempDir,
      strip: 1,
    });

    const { unlink } = await import("node:fs/promises");
    await unlink(archivePath).catch((error: any) => {
      console.error(
        `[${owner}/${repo}] Error cleaning up archive file:`,
        error.message
      );
    });

    console.log(
      `[${owner}/${repo}] Successfully downloaded repository archive`
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error downloading repository archive:`,
      error.message
    );
    throw error;
  }
}

/**
 * Recursively gets all files in Shopify root structure folders only
 * Filters to include only: assets, blocks, config, layout, locales, sections, snippets, templates
 */
function getShopifyFiles(
  owner: string,
  repo: string,
  dir: string,
  baseDir: string = dir
): Array<{ path: string; content: Buffer }> {
  console.log(`[${owner}/${repo}] Reading Shopify theme files...`);

  const shopifyFolders = [
    "assets",
    "blocks",
    "config",
    "layout",
    "locales",
    "sections",
    "snippets",
    "templates",
  ];

  const files: Array<{ path: string; content: Buffer }> = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = fullPath.replace(baseDir + "/", "");
      const stat = statSync(fullPath);

      const isInShopifyFolder = shopifyFolders.some(
        (folder) =>
          relativePath.startsWith(folder + "/") || relativePath === folder
      );

      if (!isInShopifyFolder) continue;

      if (stat.isDirectory()) {
        files.push(...getShopifyFiles(owner, repo, fullPath, baseDir));
      } else if (stat.isFile()) {
        const content = readFileSync(fullPath);
        files.push({ path: relativePath, content });
      }
    }
  } catch {
    // Ignore directory read errors
  }

  console.log(`[${owner}/${repo}] Found ${files.length} theme files to upload`);

  return files;
}

/**
 * Creates a zip archive from theme files
 */
async function createThemeArchive(
  owner: string,
  repo: string,
  files: Array<{ path: string; content: Buffer }>,
  archivePath: string,
  tempDir: string
): Promise<void> {
  console.log(
    `[${owner}/${repo}] Creating zip file with ${files.length} files...`
  );

  return new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(
        `[${owner}/${repo}] Zip file created: ${archive.pointer()} bytes`
      );
      resolve();
    });

    archive.on("error", (error: Error) => {
      reject(error);
    });

    archive.pipe(output);

    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }

    archive.finalize();
  });
}

interface FileUploadResponse {
  resourceUrl: string | null;
  error?: string;
}

const getStagedTarget = async (
  storeName: string,
  owner: string,
  repo: string,
  archiveBuffer: Buffer
): Promise<string | null> => {
  console.log(`[${owner}/${repo}] Uploading file to ${storeName} via public API...`);

  // Convert buffer to base64
  const base64Data = archiveBuffer.toString("base64");

  // Call the public API endpoint
  const apiUrl = "https://tyz-actions-access.vercel.app/api/file/upload";
  const uploadResponse = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      shop: `${storeName}.myshopify.com`,
      fileData: base64Data,
      filename: `theme-${Date.now()}.zip`,
      mimeType: "application/zip",
    }),
  });

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => "");
    throw new Error(
      `[${owner}/${repo}] File upload API failed: ${uploadResponse.status} ${uploadResponse.statusText} ${text}`
    );
  }

  const result = (await uploadResponse.json()) as FileUploadResponse;

  if (result.error) {
    throw new Error(
      `[${owner}/${repo}] File upload API error: ${result.error}`
    );
  }

  if (!result.resourceUrl) {
    console.error(`[${owner}/${repo}] No resourceUrl returned from API`);
    return null;
  }

  console.log(
    `[${owner}/${repo}] Successfully uploaded file and received resourceUrl`
  );

  // This URL is what we pass as originalSource to themeCreate
  return result.resourceUrl;
};

/**
 * Uploads the theme files to the store and returns the resourceUrl
 */
const handleFileUpload = async (
  storeName: string,
  owner: string,
  repo: string,
  themeFiles: Array<{ path: string; content: Buffer }>,
  tempDir: string
): Promise<string | null> => {
  const archivePath = `${tempDir}/theme.zip`;
  await createThemeArchive(owner, repo, themeFiles, archivePath, tempDir);
  const archiveBuffer = readFileSync(archivePath);

  const resourceUrl = await getStagedTarget(
    storeName,
    owner,
    repo,
    archiveBuffer
  );
  if (!resourceUrl) {
    throw new Error("Failed to get staged upload resource URL");
  }

  return resourceUrl;
};

/**
 * Binary file extensions that must be base64-encoded rather than UTF-8 decoded
 */
const BINARY_EXTENSIONS = new Set([
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".mp4",
  ".webm",
  ".pdf",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

interface ThemeFileInput {
  filename: string;
  content?: string;
  attachment?: string;
}

interface ThemeUpdateResponse {
  upsertedFiles?: Array<{
    filename: string;
  }>;
  userErrors?: Array<{
    field: string[];
    message: string;
  }>;
  error?: string;
}

/**
 * Updates theme files using themeFilesUpsert, batching files in chunks of 50
 */
async function updateThemeFiles(
  storeName: string,
  themeId: string,
  owner: string,
  repo: string,
  themeFiles: Array<{ path: string; content: Buffer }>
): Promise<void> {
  const apiUrl = "https://tyz-actions-access.vercel.app/api/theme/update";
  const maxFilesPerBatch = 50;

  // Convert themeFiles to API format
  // Binary files (fonts, images, etc.) must be base64-encoded to avoid corruption
  const files: ThemeFileInput[] = themeFiles.map((file) => {
    if (isBinaryFile(file.path)) {
      return {
        filename: file.path,
        attachment: file.content.toString("base64"),
      };
    }
    return {
      filename: file.path,
      content: file.content.toString("utf8"),
    };
  });

  console.log(
    `[${owner}/${repo}] Updating ${files.length} files in batches of ${maxFilesPerBatch}...`
  );

  // Process files in batches of 50
  for (let i = 0; i < files.length; i += maxFilesPerBatch) {
    const batch = files.slice(i, i + maxFilesPerBatch);
    const batchNumber = Math.floor(i / maxFilesPerBatch) + 1;
    const totalBatches = Math.ceil(files.length / maxFilesPerBatch);

    console.log(
      `[${owner}/${repo}] Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)...`
    );

    const updateResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop: `${storeName}.myshopify.com`,
        themeId: themeId,
        files: batch,
      }),
    });

    if (!updateResponse.ok) {
      const text = await updateResponse.text().catch(() => "");
      throw new Error(
        `[${owner}/${repo}] Theme update API failed for batch ${batchNumber}: ${updateResponse.status} ${updateResponse.statusText} ${text}`
      );
    }

    const updateResult = (await updateResponse.json()) as ThemeUpdateResponse;

    if (updateResult.error) {
      throw new Error(
        `[${owner}/${repo}] Failed to update theme files in batch ${batchNumber}: ${updateResult.error}`
      );
    }

    if (updateResult.userErrors && updateResult.userErrors.length > 0) {
      const errors = updateResult.userErrors;
      throw new Error(
        `[${owner}/${repo}] Failed to update theme files in batch ${batchNumber}: ${JSON.stringify(errors)}`
      );
    }

    console.log(
      `[${owner}/${repo}] Successfully updated batch ${batchNumber}/${totalBatches} (${updateResult.upsertedFiles?.length || batch.length} files)`
    );
  }

  console.log(
    `[${owner}/${repo}] Successfully updated all ${files.length} theme files`
  );
}

/**
 * Creates or updates a Shopify preview theme using Admin API
 */
async function createOrUpdatePreviewTheme(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest,
  storeName: string,
  existingThemeId: string | null
): Promise<void> {
  const tempDir = `/tmp/preview-${owner}-${repo}-${pr.number}-${Date.now()}`;

  await downloadAndExtractRepository(octokit, owner, repo, pr, tempDir);

  const themeFiles = getShopifyFiles(owner, repo, tempDir);

  let themeId: string;
  let themeUrl: string;

  if (existingThemeId) {
    console.log(
      `[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`
    );

    themeId = existingThemeId;

    // Update theme files using themeFilesUpsert
    await updateThemeFiles(storeName, themeId, owner, repo, themeFiles);

    themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
    console.log(
      `[${owner}/${repo}] Successfully updated preview theme ${themeId}`
    );

    await saveThemeIdToDescription(octokit, owner, repo, pr.number, themeId);

    // Poll theme status every 5 seconds until it's ready
    await waitForThemeReady(storeName, themeId, owner, repo);

    await commentPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number,
      themeId,
      storeName,
      "update"
    );
  } else {
    // For create, we still need to upload the zip file
    const resourceUrl = await handleFileUpload(
      storeName,
      owner,
      repo,
      themeFiles,
      tempDir
    );

    if (!resourceUrl)
      throw new Error("Failed to upload file and get resource URL");

    console.log(`[${owner}/${repo}] Creating new preview theme...`);

    const themeName = `Tryzens/Preview - PR #${
      pr.number
    } (${formatDateDDMMYY()})`;
    const apiUrl = "https://tyz-actions-access.vercel.app/api/theme/create";

    const createResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop: `${storeName}.myshopify.com`,
        source: resourceUrl,
        name: themeName,
      }),
    });

    if (!createResponse.ok) {
      const text = await createResponse.text().catch(() => "");
      throw new Error(
        `[${owner}/${repo}] Theme create API failed: ${createResponse.status} ${createResponse.statusText} ${text}`
      );
    }

    const createResult = (await createResponse.json()) as {
      theme?: {
        id: string;
        name: string;
      };
      userErrors?: Array<{ field: string[]; message: string }>;
      error?: string;
    };

    console.log(
      `[${owner}/${repo}] Create result:`,
      JSON.stringify(createResult, null, 2)
    );

    if (createResult.error) {
      throw new Error(
        `[${owner}/${repo}] Failed to create theme: ${createResult.error}`
      );
    }

    if (createResult.userErrors && createResult.userErrors.length > 0) {
      const errors = createResult.userErrors;
      throw new Error(`Failed to create theme: ${JSON.stringify(errors)}`);
    }

    if (!createResult.theme || !createResult.theme.id) {
      throw new Error("Failed to get theme ID from create response");
    }

    const themeGid = createResult.theme.id;
    themeId = themeGid.split("/").pop() || "";

    themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
    console.log(
      `[${owner}/${repo}] Successfully created preview theme ${themeId}`
    );

    await saveThemeIdToDescription(octokit, owner, repo, pr.number, themeId);

    // Poll theme status every 5 seconds until it's ready
    await waitForThemeReady(storeName, themeId, owner, repo);

    await commentPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number,
      themeId,
      storeName,
      "create"
    );
  }

  // Clean up temporary directory
  const { rm } = await import("node:fs/promises");
  await rm(tempDir, { recursive: true, force: true }).catch(
    (error: unknown) => {
      console.log(
        `[${owner}/${repo}] Error cleaning up temporary directory:`,
        error
      );
    }
  );

    console.log(`[${owner}/${repo}] Preview theme ready: ${themeUrl}`);
}

/**
 * Deletes a preview theme when PR is merged
 */
export async function deletePreviewTheme(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest
): Promise<void> {
  try {
    const storeName = await extractStoreNameFromHomepage(
      octokit,
      owner,
      repo,
      pr
    );
    if (!storeName) {
      console.log(
        `[${owner}/${repo}] No store name found, skipping theme deletion`
      );
      return;
    }

    const existingThemeId = await getExistingPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number
    );

    if (!existingThemeId) {
      console.log(
        `[${owner}/${repo}] No preview theme ID found in PR description, skipping deletion`
      );
      return;
    }

    console.log(
      `[${owner}/${repo}] Deleting preview theme ${existingThemeId}...`
    );

    const apiUrl = "https://tyz-actions-access.vercel.app/api/theme/delete";
    const deleteResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop: `${storeName}.myshopify.com`,
        themeId: existingThemeId,
      }),
    });

    if (!deleteResponse.ok) {
      const text = await deleteResponse.text().catch(() => "");
      throw new Error(
        `[${owner}/${repo}] Theme delete API failed: ${deleteResponse.status} ${deleteResponse.statusText} ${text}`
      );
    }

    const deleteResult = (await deleteResponse.json()) as {
      deletedThemeId?: string;
      userErrors?: Array<{ field: string[]; message: string }>;
      error?: string;
    };

    console.log(
      `[${owner}/${repo}] Delete result:`,
      JSON.stringify(deleteResult, null, 2)
    );

    if (deleteResult.error) {
      throw new Error(
        `[${owner}/${repo}] Failed to delete theme: ${deleteResult.error}`
      );
    }

    if (deleteResult.userErrors && deleteResult.userErrors.length > 0) {
      const errors = deleteResult.userErrors;
      throw new Error(`Failed to delete theme: ${JSON.stringify(errors)}`);
    }

    console.log(
      `[${owner}/${repo}] Successfully deleted preview theme ${existingThemeId}`
    );

    // Comment on PR about successful deletion
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pr.number,
        body: `✅ Preview theme ${existingThemeId} has been successfully deleted.`,
      }
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error deleting preview theme:`,
      error.message
    );

    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pr.number,
        body: `⚠️ Error deleting preview theme: ${error.message}. The theme may need to be deleted manually.`,
      }
    );
  }
}

/**
 * Handles the preview label being added to a PR
 */
export async function handlePreviewTheme(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest
): Promise<void> {
  try {
    const storeName = await extractStoreNameFromHomepage(
      octokit,
      owner,
      repo,
      pr
    );
    if (!storeName) return;

    const existingThemeId = await getExistingPreviewThemeId(
      octokit,
        owner,
        repo,
      pr.number
    );

    await createOrUpdatePreviewTheme(
      octokit,
      owner,
      repo,
      pr,
      storeName,
      existingThemeId
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error handling preview generation, please contact a senior developer.`,
      error.message
    );

    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pr.number,
        body: `❌ Error creating preview theme: ${error.message}`,
    }
    );
  }
}
