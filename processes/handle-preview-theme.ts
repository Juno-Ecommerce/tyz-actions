import { Octokit } from "@octokit/core";
import { PullRequest } from "@octokit/webhooks-types";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import * as tar from "tar";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

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
    console.error(`[${owner}/${repo}] Could not extract store name from repository homepage`);

    // Comment on PR about the issue
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pr.number,
      body: "❌ Could not create preview theme. Please add a Shopify admin URL to the repository homepage (e.g., `https://admin.shopify.com/store/your-store-name`)."
    });
  }

  // Get repository data
  const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
    owner,
    repo
  });

  if (!repoData.homepage) {
    await displayMissingStoreNameError();
    return null;
  }

  // Match Shopify admin URLs
  const match = repoData.homepage.match(/https?:\/\/admin\.shopify\.com\/store\/([a-zA-Z0-9-]+)/i);
  if (match && match[1]) {
    return match[1];
  }

  await displayMissingStoreNameError();
  return null;
}

/**
 * Gets the Admin API token for the store. This should be set as a Custom App on each store with Admin API Access for read_themes and write_themes scopes.
 * @returns The Admin API token for the store
 */
const getAdminApiToken = async (
  octokit: Octokit,
  pr: PullRequest,
  owner: string,
  repo: string
): Promise<string | undefined> => {
  if (process.env.SHOPIFY_THEME_ACCESS_TOKEN) {
    return process.env.SHOPIFY_THEME_ACCESS_TOKEN;
  } else {
    // Get Admin API token from environment
    // This should be a store-specific Admin API access token (starts with shpat_)
    // Generated from a custom app in the store's admin
    console.error(`[${owner}/${repo}] Could not extract store name from repository homepage`);

    // Comment on PR about the issue
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pr.number,
      body: "❌ SHOPIFY_THEME_ACCESS_TOKEN environment variable is not set. This should be a store-specific Admin API access token."
    });

    return undefined;
  }
}

/**
 * Checks PR comments for an existing preview theme ID
 * Looks for a comment with pattern: "Preview Theme ID: <id>"
 */
async function getExistingPreviewThemeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string | null> {
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
async function downloadAndExtractRepository(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest,
  tempDir: string
): Promise<void> {
  try {
    console.log(`[${owner}/${repo}] Downloading repository to ${tempDir}...`);

    // Create temp directory
    mkdirSync(tempDir, { recursive: true });

    // Download the archive using GitHub API
    console.log(`[${owner}/${repo}] Downloading repository archive for ref: ${pr.head.ref}...`);
    const { data: archive } = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner,
      repo,
      ref: pr.head.ref,
      request: {
        responseType: "arraybuffer"
      }
    });

    // Write archive to file
    const archivePath = `${tempDir}/archive.tar.gz`;
    console.log(`[${owner}/${repo}] Writing archive to ${archivePath}...`);
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
    await unlink(archivePath).catch((error: any) => {
      console.error(`[${owner}/${repo}] Error cleaning up archive file:`, error.message);
    });

    console.log(`[${owner}/${repo}] Successfully downloaded repository archive`);
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error downloading repository archive:`, error.message);
    throw error;
  }
}

/**
 * Recursively gets all files in Shopify root structure folders only
 * Filters to include only: assets, blocks, config, layout, locales, sections, snippets, templates
 * Excludes all build files and other non-Shopify files
 */
function getShopifyFiles(
  owner: string,
  repo: string,
  dir: string,
  baseDir: string = dir
): Array<{ path: string; content: Buffer }> {
  console.log(`[${owner}/${repo}] Reading Shopify theme files...`);

  // Define Shopify root structure folders (exclude build files and other directories)
  const shopifyFolders = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];

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

      if (!isInShopifyFolder) continue; // Skip files outside Shopify folders

      if (stat.isDirectory()) {
        // Recursively get files from subdirectories
        files.push(...getShopifyFiles(owner, repo, fullPath, baseDir));
      } else if (stat.isFile()) {
        // Read file content
        const content = readFileSync(fullPath);
        files.push({ path: relativePath, content });
      }
    }
  } catch (error) {
    // Ignore errors reading directories
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
  console.log(`[${owner}/${repo}] Creating zip file with ${files.length} files...`);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`[${owner}/${repo}] Zip file created: ${archive.pointer()} bytes`);
      resolve();
    });

    archive.on('error', (error: Error) => {
      reject(error);
    });

    archive.pipe(output);

    // Add all files to the archive
    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }

    archive.finalize();
  });
}

const getStagedTarget = async (
  graphqlUrl: string,
  adminApiToken: string,
  owner: string,
  repo: string,
  archiveBuffer: Buffer
): Promise<string | null> => {
  console.log(`[${owner}/${repo}] Creating staged upload...`);

  const stagedUploadResponse = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': adminApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              resourceUrl
              url
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        input: [{
          filename: `theme-${Date.now()}.zip`,
          mimeType: 'application/zip',
          fileSize: archiveBuffer.length.toString(),
          resource: 'FILE'
        }]
      }
    })
  });

  const stagedUploadResult = await stagedUploadResponse.json() as {
    data: {
      stagedUploadsCreate: {
        stagedTargets: {
          resourceUrl: string;
          url: string;
          parameters?: Array<{ name: string; value: string }>;
        }[];
        userErrors: { field: string[]; message: string }[];
      };
    };
  };

  console.log(`[${owner}/${repo}] Staged upload result:`, JSON.stringify(stagedUploadResult, null, 2));

  if (stagedUploadResult.data?.stagedUploadsCreate?.userErrors?.length ?? 0 > 0) {
    const errors = stagedUploadResult.data?.stagedUploadsCreate?.userErrors;
    throw new Error(`Failed to create staged upload: ${JSON.stringify(errors)}`);
  }

  const stagedTarget = stagedUploadResult.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!stagedTarget) {
    console.error(`[${owner}/${repo}] Failed to get staged upload target`);
    return null;
  }

  // Step 2: Upload the file directly to the staged upload URL with authentication parameters
  console.log(`[${owner}/${repo}] Uploading file to staged upload URL...`);

  // Build multipart/form-data manually
  const boundary = `----WebKitFormBoundary${Date.now()}`;
  const formParts: Buffer[] = [];

  // Add authentication parameters from staged upload
  for (const param of stagedTarget.parameters || []) {
    formParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${param.name}"\r\n\r\n` +
      `${param.value}\r\n`
    ));
  }

  // Add file
  formParts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="theme.zip"\r\n` +
    `Content-Type: application/zip\r\n\r\n`
  ));
  formParts.push(archiveBuffer);
  formParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const formData = Buffer.concat(formParts);

  const uploadResponse = await fetch(stagedTarget.url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: formData
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(`Failed to upload file to staged upload URL: ${uploadResponse.statusText} - ${errorText}`);
  }

  console.log(`[${owner}/${repo}] Successfully uploaded file to staged upload URL`);

  // Return the resourceUrl to be used as originalSource in fileCreate
  return stagedTarget.resourceUrl;
}

const uploadToStagedTarget = async (
  graphqlUrl: string,
  adminApiToken: string,
  owner: string,
  repo: string,
  stagedTarget: string
): Promise<string | null> => {
  console.log(`[${owner}/${repo}] Uploading zipped theme files to staged target...`);

  const fileCreateResponse = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': adminApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              id
              fileStatus
              createdAt
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        files: [
          {
            contentType: "FILE",
            originalSource: stagedTarget,
          }
        ]
      }
    })
  });

  const fileCreateResult = await fileCreateResponse.json() as {
    fileCreate: {
      files: {
        id: string;
        fileStatus: string;
        createdAt: string;
      }[];
    };
    userErrors: { field: string[]; message: string }[];
  };

  console.log(`[${owner}/${repo}] File create result:`, JSON.stringify(fileCreateResult, null, 2));

  if (fileCreateResult.userErrors.length ?? 0 > 0) {
    const errors = fileCreateResult.userErrors;
    throw new Error(`Failed to create file: ${JSON.stringify(errors)}`);
  }

  return fileCreateResult.fileCreate.files[0].id;
}

/**
 * Uploads the theme files to the store and returns the file ID
 */
const handleFileUpload = async (
  graphqlUrl: string,
  owner: string,
  repo: string,
  themeFiles: Array<{ path: string; content: Buffer }>,
  tempDir: string,
  adminApiToken: string
): Promise<string | null> => {
  const archivePath = `${tempDir}/theme.zip`;
  await createThemeArchive(owner, repo, themeFiles, archivePath, tempDir);
  const archiveBuffer = readFileSync(archivePath);

  const resourceUrl = await getStagedTarget(graphqlUrl, adminApiToken, owner, repo, archiveBuffer);
  if (!resourceUrl) {
    throw new Error('Failed to get staged upload resource URL');
  }

  // File has been uploaded to staged upload URL in getStagedTarget
  // Return the resourceUrl to be used as originalSource in theme creation
  return resourceUrl;
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
  existingThemeId: string | null,
  adminApiToken: string
): Promise<void> {
  try {
    const graphqlUrl = `https://${storeName}.myshopify.com/admin/api/2025-10/graphql.json`;
    const tempDir = `/tmp/preview-${owner}-${repo}-${pr.number}-${Date.now()}`;

    // Step 1: Download and extract the repository
    await downloadAndExtractRepository(octokit, owner, repo, pr, tempDir);

    // Step 2: Filter to get only Shopify root structure files (assets, blocks, config, layout, locales, sections, snippets, templates)
    const themeFiles = getShopifyFiles(owner, repo, tempDir);

    // Step 3: Upload the file to staged upload and get resourceUrl
    const resourceUrl = await handleFileUpload(graphqlUrl, owner, repo, themeFiles, tempDir, adminApiToken);
    if (!resourceUrl) {
      throw new Error('Failed to upload file and get resource URL');
    }

    let themeId: string;
    let themeUrl: string;

    if (existingThemeId) {
      // Update existing preview theme
      console.log(`[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`);
      themeId = existingThemeId;

      // Upload files to existing theme using GraphQL
      console.log(`[${owner}/${repo}] Uploading ${themeFiles.length} files to theme...`);
      for (const file of themeFiles) {
        try {
          const themeFilesUpdateMutation = `
            mutation themeFilesUpdate($themeId: ID!, $files: [ThemeFileInput!]!) {
              themeFilesUpdate(themeId: $themeId, files: $files) {
                theme {
                  id
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const response = await fetch(graphqlUrl, {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': adminApiToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: themeFilesUpdateMutation,
              variables: {
                themeId: `gid://shopify/Theme/${themeId}`,
                files: [{
                  key: file.path,
                  value: file.content.toString('utf8'),
                }]
              }
            })
          });

          const result = await response.json() as {
            errors?: Array<{ message: string }>;
            data?: {
              themeFilesUpdate?: {
                userErrors?: Array<{ field: string[]; message: string }>;
              };
            };
          };
          if (result.errors || (result.data?.themeFilesUpdate?.userErrors?.length ?? 0 > 0)) {
            const errors = result.errors || result.data?.themeFilesUpdate?.userErrors;
            console.warn(`[${owner}/${repo}] Failed to update ${file.path}:`, JSON.stringify(errors));
          } else {
            console.log(`[${owner}/${repo}] Updated ${file.path}`);
          }
        } catch (error: any) {
          console.warn(`[${owner}/${repo}] Error updating ${file.path}:`, error.message);
        }
      }

      themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
      console.log(`[${owner}/${repo}] Successfully updated preview theme ${themeId}`);
    } else {
      // Create new unpublished theme using GraphQL with staged upload
      console.log(`[${owner}/${repo}] Creating new preview theme...`);

      // Step 4: Create the theme using the resourceUrl as originalSource
      console.log(`[${owner}/${repo}] Creating theme from staged upload resource URL...`);
      const createThemeMutation = `
        mutation themeCreate($theme: ThemeCreateInput!) {
          themeCreate(theme: $theme) {
            theme {
              id
              name
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const createResponse = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': adminApiToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: createThemeMutation,
          variables: {
            theme: {
              name: `Preview - PR #${pr.number}`,
              role: 'DEVELOPMENT',
              originalSource: resourceUrl
            }
          }
        })
      });

      const createResult = await createResponse.json() as {
        errors?: Array<{ message: string }>;
        data?: {
          themeCreate?: {
            theme?: {
              id: string;
              name: string;
            };
            userErrors?: Array<{ field: string[]; message: string }>;
          };
        };
      };

      if (createResult.errors || (createResult.data?.themeCreate?.userErrors?.length ?? 0 > 0)) {
        const errors = createResult.errors || createResult.data?.themeCreate?.userErrors;
        throw new Error(`Failed to create theme: ${JSON.stringify(errors)}`);
      }

      // Extract theme ID from GraphQL response (format: gid://shopify/Theme/123456789)
      const themeGid = createResult.data?.themeCreate?.theme?.id;
      if (!themeGid) {
        throw new Error('Failed to get theme ID from create response');
      }
      themeId = themeGid.split('/').pop() || '';

      themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
      console.log(`[${owner}/${repo}] Successfully created preview theme ${themeId}`);
      
      // Comment the theme ID on the PR for future updates
      await commentPreviewThemeId(octokit, owner, repo, pr.number, themeId);
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
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: PullRequest
): Promise<void> {
  try {
    const storeName = await extractStoreNameFromHomepage(octokit, owner, repo, pr);
    if (!storeName) return;

    const adminApiToken = await getAdminApiToken(octokit, pr, owner, repo);
    if (!adminApiToken) return;

    // Check if a preview theme already exists for this PR
    const existingThemeId = await getExistingPreviewThemeId(octokit, owner, repo, pr.number);

    // Create or update the preview theme
    await createOrUpdatePreviewTheme(
      octokit,
      owner,
      repo,
      pr,
      storeName,
      existingThemeId,
      adminApiToken
    );
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error handling preview generation, please contact a senior developer.`, error.message);

      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: pr.number,
        body: `❌ Error creating preview theme: ${error.message}`
      });
  }
}

