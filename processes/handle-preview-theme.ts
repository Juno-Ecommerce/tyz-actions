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
  };

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
    console.error(`[${owner}/${repo}] SHOPIFY_THEME_ACCESS_TOKEN environment variable is not set`);

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pr.number,
      body: "❌ SHOPIFY_THEME_ACCESS_TOKEN environment variable is not set. This should be a store-specific Admin API access token."
    });

    return undefined;
  }
};

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
async function commentPreviewThemeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  themeId: string
): Promise<void> {
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

    mkdirSync(tempDir, { recursive: true });

    console.log(`[${owner}/${repo}] Downloading repository archive for ref: ${pr.head.ref}...`);
    const { data: archive } = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner,
      repo,
      ref: pr.head.ref,
      request: {
        responseType: "arraybuffer"
      }
    });

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
      strip: 1
    });

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
    "templates"
  ];

  const files: Array<{ path: string; content: Buffer }> = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = fullPath.replace(baseDir + "/", "");
      const stat = statSync(fullPath);

      const isInShopifyFolder = shopifyFolders.some(folder =>
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
  console.log(`[${owner}/${repo}] Creating zip file with ${files.length} files...`);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`[${owner}/${repo}] Zip file created: ${archive.pointer()} bytes`);
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

type StagedUploadResponse = {
  data?: {
    stagedUploadsCreate: {
      stagedTargets: {
        resourceUrl: string;
        url: string;
        parameters?: Array<{ name: string; value: string }>;
      }[];
      userErrors: { field: string[]; message: string }[];
    };
  };
  errors?: { message: string }[];
};

const getStagedTarget = async (
  graphqlUrl: string,
  adminApiToken: string,
  owner: string,
  repo: string,
  archiveBuffer: Buffer
): Promise<string | null> => {
  console.log(`[${owner}/${repo}] Creating staged upload...`);

  const stagedUploadResponse = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": adminApiToken,
      "Content-Type": "application/json"
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
        input: [
          {
            filename: `theme-${Date.now()}.zip`,
            mimeType: "application/zip",
            fileSize: archiveBuffer.length.toString(),
            resource: "FILE",
            httpMethod: "POST"
          }
        ]
      }
    })
  });

  if (!stagedUploadResponse.ok) {
    const text = await stagedUploadResponse.text().catch(() => "");
    throw new Error(
      `[${owner}/${repo}] stagedUploadsCreate failed: ${stagedUploadResponse.status} ${stagedUploadResponse.statusText} ${text}`
    );
  }

  const stagedUploadResult = (await stagedUploadResponse.json()) as StagedUploadResponse;

  console.log(
    `[${owner}/${repo}] Staged upload result:`,
    JSON.stringify(stagedUploadResult, null, 2)
  );

  if (stagedUploadResult.errors?.length) {
    throw new Error(
      `Failed to create staged upload (top-level errors): ${JSON.stringify(
        stagedUploadResult.errors
      )}`
    );
  }

  const stagedCreate = stagedUploadResult.data?.stagedUploadsCreate;
  if (!stagedCreate) {
    throw new Error("stagedUploadsCreate missing in response");
  }

  if (stagedCreate.userErrors.length > 0) {
    throw new Error(
      `Failed to create staged upload: ${JSON.stringify(stagedCreate.userErrors)}`
    );
  }

  const stagedTarget = stagedCreate.stagedTargets[0];
  if (!stagedTarget) {
    console.error(`[${owner}/${repo}] Failed to get staged upload target`);
    return null;
  }

  console.log(`[${owner}/${repo}] Uploading file to staged upload URL...`);

  // Use FormData so we don't have to hand-roll multipart
  const formData = new FormData();

  for (const param of stagedTarget.parameters || []) {
    formData.append(param.name, param.value);
  }

  // File MUST be the last field
  const zipBlob = new Blob([archiveBuffer], { type: "application/zip" });
  formData.append("file", zipBlob, "theme.zip");

  const uploadResponse = await fetch(stagedTarget.url, {
    method: "POST",
    body: formData
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text().catch(() => "");
    throw new Error(
      `Failed to upload file to staged upload URL: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`
    );
  }

  console.log(`[${owner}/${repo}] Successfully uploaded file to staged upload URL`);

  // This URL is what we pass as originalSource to themeCreate
  return stagedTarget.resourceUrl;
};

/**
 * Uploads the theme files to the store and returns the resourceUrl
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

  const resourceUrl = await getStagedTarget(
    graphqlUrl,
    adminApiToken,
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
  const graphqlUrl = `https://${storeName}.myshopify.com/admin/api/2025-10/graphql.json`;
  const tempDir = `/tmp/preview-${owner}-${repo}-${pr.number}-${Date.now()}`;

  await downloadAndExtractRepository(octokit, owner, repo, pr, tempDir);

  const themeFiles = getShopifyFiles(owner, repo, tempDir);

  const resourceUrl = await handleFileUpload(
    graphqlUrl,
    owner,
    repo,
    themeFiles,
    tempDir,
    adminApiToken
  );
  if (!resourceUrl) throw new Error("Failed to upload file and get resource URL");

  let themeId: string;
  let themeUrl: string;

  if (existingThemeId) {
    console.log(
      `[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`
    );
    themeId = existingThemeId;

    console.log(`[${owner}/${repo}] Creating new preview theme...`);

    const createResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
           mutation themeUpdate($id: ID!, $input: OnlineStoreThemeInput!) {
            themeUpdate(id: $id, input: $input) {
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
        `,
        variables: {
          id: `gid://shopify/OnlineStoreTheme/${existingThemeId}`,
          input: {
            name: `Tryzens/Preview - PR #${pr.number} ${Date.now()}`
          }
        }
      })
    });

    const createResult = (await createResponse.json()) as {
      data: {
        themeCreate: {
          theme: {
            id: string;
            name: string;
          };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    };

    console.log(`[${owner}/${repo}] Create result:`, JSON.stringify(createResult, null, 2));

    if (createResult.data.themeCreate.userErrors.length > 0) {
      const errors = createResult.data.themeCreate.userErrors;
      throw new Error(`Failed to create theme: ${JSON.stringify(errors)}`);
    }

    const themeGid = createResult.data.themeCreate.theme.id;
    if (!themeGid) {
      throw new Error("Failed to get theme ID from create response");
    }
    themeId = themeGid.split("/").pop() || "";

    themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
    console.log(`[${owner}/${repo}] Successfully created preview theme ${themeId}`);

    await commentPreviewThemeId(octokit, owner, repo, pr.number, themeId);
  } else {
    console.log(`[${owner}/${repo}] Creating new preview theme...`);

    const createResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: `
           mutation themeCreate($source: URL!, $name: String!) {
            themeCreate(source: $source, name: $name) {
              theme {
                name
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          name: `Tryzens/Preview - PR #${pr.number} ${Date.now()}`,
          source: resourceUrl
        }
      })
    });

    const createResult = (await createResponse.json()) as {
      data: {
        themeCreate: {
          theme: {
            id: string;
            name: string;
          };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
    };

    console.log(`[${owner}/${repo}] Create result:`, JSON.stringify(createResult, null, 2));

    if (createResult.data.themeCreate.userErrors.length > 0) {
      const errors = createResult.data.themeCreate.userErrors;
      throw new Error(`Failed to create theme: ${JSON.stringify(errors)}`);
    }

    const themeGid = createResult.data.themeCreate.theme.id;
    if (!themeGid) {
      throw new Error("Failed to get theme ID from create response");
    }
    themeId = themeGid.split("/").pop() || "";

    themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
    console.log(`[${owner}/${repo}] Successfully created preview theme ${themeId}`);

    await commentPreviewThemeId(octokit, owner, repo, pr.number, themeId);
  }

  // Clean up temporary directory
  const { rm } = await import("node:fs/promises");
  await rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
    console.log(`[${owner}/${repo}] Error cleaning up temporary directory:`, error);
  });

  console.log(`[${owner}/${repo}] Preview theme ready: ${themeUrl}`);
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
      existingThemeId,
      adminApiToken
    );
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error handling preview generation, please contact a senior developer.`,
      error.message
    );

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pr.number,
      body: `❌ Error creating preview theme: ${error.message}`
    });
  }
}
