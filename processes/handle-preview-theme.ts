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
import * as tar from "tar";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

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
 * Checks if a theme is ready by querying its status via GraphQL
 */
async function isThemeReady(
  graphqlUrl: string,
  adminApiToken: string,
  themeId: string,
  storeName: string,
  owner: string,
  repo: string
): Promise<boolean> {
  try {
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query getThemeStatus($id: ID!) {
            theme(id: $id) {
              processing
            }
          }
        `,
        variables: {
          id: `gid://shopify/OnlineStoreTheme/${themeId}`,
        },
      }),
    });

    if (!response.ok) {
      return false;
    }

    const result = (await response.json()) as {
      data?: {
        theme: {
          processing: boolean;
        } | null;
      };
      errors?: { message: string }[];
    };

    // If there are errors or theme is null, it's not ready
    if (result.errors?.length || !result.data?.theme || result.data.theme.processing === true) {
      return false;
    }

    // Theme exists and is accessible via GraphQL
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
      // If preview check fails, assume theme is ready if GraphQL query succeeded
      return true;
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
  graphqlUrl: string,
  adminApiToken: string,
  themeId: string,
  storeName: string,
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
    const isReady = await isThemeReady(
      graphqlUrl,
      adminApiToken,
      themeId,
      storeName,
      owner,
      repo
    );

    if (isReady) {
      console.log(
        `[${owner}/${repo}] Theme ${themeId} is ready after ${Math.round((Date.now() - startTime) / 1000)} seconds`
      );
      return true;
    }

    // Wait 5 seconds before next poll
    await delay(pollInterval);
  }

  console.warn(
    `[${owner}/${repo}] Theme ${themeId} did not become ready within ${maxWaitTime / 1000} seconds`
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
 * Gets the Admin API token for the store from GitHub repository variables.
 * This should be set as a repository variable called TYZ_ACTIONS_ACCESS_KEY.
 * The token should be a Custom App on each store with Admin API Access for read_themes and write_themes scopes.
 * @returns The Admin API token for the store
 */
const getAdminApiToken = async (
  octokit: Octokit,
  pr: PullRequest,
  owner: string,
  repo: string
): Promise<string | undefined> => {
  try {
    // Fetch the repository variable TYZ_ACTIONS_ACCESS_KEY
    const { data: variable } = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/variables/{name}",
      {
        owner,
        repo,
        name: "TYZ_ACTIONS_ACCESS_KEY",
      }
    );

    if (variable.value) {
      return variable.value;
    }
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Failed to fetch TYZ_ACTIONS_ACCESS_KEY repository variable:`,
      error.message
    );

    // Check if it's a 404 (variable doesn't exist) or other error
    if (error.status === 404) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: pr.number,
          body: "❌ TYZ_ACTIONS_ACCESS_KEY repository variable is not set. Please add this variable in your repository settings (Settings > Secrets and variables > Actions > Variables). This should be a store-specific Admin API access token.",
        }
      );
    } else {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: pr.number,
          body: `❌ Error fetching TYZ_ACTIONS_ACCESS_KEY repository variable: ${error.message}. Please ensure the variable exists and the app has the necessary permissions.`,
        }
      );
    }

    return undefined;
  }

  return undefined;
};

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
    updatedBody = updatedBody.replace(/Preview Theme ID:\s*\[?\d+\]?/gi, "").trim();

    // Add the Preview Theme ID with warnings and square brackets
    const themeIdSection = `
      \n\n\n\n\n\n
      ⚠️ WARNING: DO NOT REMOVE ⚠️
      [preview-theme-id:${themeId}]
      ⚠️ Only remove this if you want to create a new preview theme entirely ⚠️
    `;

    // Append the theme ID section
    updatedBody += themeIdSection;

    // Update the PR description
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      body: updatedBody,
    });

    console.log(`[${owner}/${repo}] Saved theme ID ${themeId} to PR description`);
  } catch (error: any) {
    console.error(
      `[${owner}/${repo}] Error saving theme ID to PR description:`,
      error.message
    );
  }
}

/**
 * Creates a comment on the PR with the preview theme ID and optional Lighthouse results
 */
async function commentPreviewThemeId(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  themeId: string,
  storeName: string,
  method: "create" | "update",
  lighthouseResults?: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
    metrics?: {
      firstContentfulPaint?: number;
      largestContentfulPaint?: number;
      totalBlockingTime?: number;
      cumulativeLayoutShift?: number;
      speedIndex?: number;
    };
  }
): Promise<void> {
  const lighthouseSection = lighthouseResults
    ? formatLighthouseResults(lighthouseResults)
    : "\n\n⏳ Calculating Lighthouse score...";

    const createBody = `
      Preview theme successfully created!

      Theme URL: https://${storeName}.myshopify.com?preview_theme_id=${themeId}
      Customiser URL: https://${storeName}.myshopify.com/admin/themes/${themeId}/editor
      Code URL: https://${storeName}.myshopify.com/admin/themes/${themeId}

      This theme will be updated automatically when you push changes to this PR.

      The theme ID has been saved into the PR description. Please only remove this id from your PR description if you want to create a new preview theme.

      ${lighthouseSection}
    `;

    const updateBody = `
      Preview theme successfully updated!

      Theme URL: https://${storeName}.myshopify.com?preview_theme_id=${themeId}
      Customiser URL: https://${storeName}.myshopify.com/admin/themes/${themeId}/editor
      Code URL: https://${storeName}.myshopify.com/admin/themes/${themeId}

      ${lighthouseSection}
    `;

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
 * Runs a Lighthouse audit on the preview theme URL
 */
async function runLighthouseAudit(
  owner: string,
  repo: string,
  previewUrl: string
): Promise<{
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  metrics?: {
    firstContentfulPaint?: number;
    largestContentfulPaint?: number;
    totalBlockingTime?: number;
    cumulativeLayoutShift?: number;
    speedIndex?: number;
  };
} | null> {
  let chrome: any = null;

  try {
    console.log(`[${owner}/${repo}] Starting Lighthouse audit for ${previewUrl}...`);

    // Set environment variables to prevent Lighthouse from loading assets during import
    // These need to be set before importing Lighthouse
    if (!process.env.LIGHTHOUSE_LOCALE) {
      process.env.LIGHTHOUSE_LOCALE = "en";
    }

    // Dynamically import to avoid loading assets/locales at module initialization
    // This prevents ENOENT errors for missing files in serverless environments
    let chromeLauncherModule;
    let lighthouseModule;

    try {
      chromeLauncherModule = await import("chrome-launcher");
      lighthouseModule = await import("lighthouse");
    } catch (importError: any) {
      // If import fails due to missing assets, log and return null
      console.error(
        `[${owner}/${repo}] Failed to import Lighthouse modules:`,
        importError.message
      );
      // Try to work around missing assets by using a minimal import
      // Some serverless environments may not include all Lighthouse assets
      if (importError.code === "ENOENT") {
        console.error(
          `[${owner}/${repo}] Lighthouse assets missing. Skipping audit.`
        );
        return null;
      }
      throw importError;
    }

    // Launch Chrome
    chrome = await chromeLauncherModule.launch({
      chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu"],
    });

    const options = {
      logLevel: "info" as const,
      output: "json" as const,
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      port: chrome.port,
      locale: "en" as const,
    };

    // Lighthouse exports as default
    const lighthouse = lighthouseModule.default || lighthouseModule;
    const runnerResult = await lighthouse(previewUrl, options);

    if (!runnerResult) {
      console.error(`[${owner}/${repo}] Lighthouse returned no results`);
      return null;
    }

    const lhr = runnerResult.lhr;
    const categories = lhr.categories;

    const performance = Math.round((categories.performance?.score || 0) * 100);
    const accessibility = Math.round((categories.accessibility?.score || 0) * 100);
    const bestPractices = Math.round((categories["best-practices"]?.score || 0) * 100);
    const seo = Math.round((categories.seo?.score || 0) * 100);

    // Extract key metrics
    const metrics = lhr.audits;
    const firstContentfulPaint = metrics["first-contentful-paint"]?.numericValue;
    const largestContentfulPaint = metrics["largest-contentful-paint"]?.numericValue;
    const totalBlockingTime = metrics["total-blocking-time"]?.numericValue;
    const cumulativeLayoutShift = metrics["cumulative-layout-shift"]?.numericValue;
    const speedIndex = metrics["speed-index"]?.numericValue;

    console.log(`[${owner}/${repo}] Lighthouse audit completed:
      Performance: ${performance}
      Accessibility: ${accessibility}
      Best Practices: ${bestPractices}
      SEO: ${seo}`);

    return {
      performance,
      accessibility,
      bestPractices,
      seo,
      metrics: {
        firstContentfulPaint,
        largestContentfulPaint,
        totalBlockingTime,
        cumulativeLayoutShift,
        speedIndex,
      },
    };
  } catch (error: any) {
    console.error(`[${owner}/${repo}] Error running Lighthouse audit:`, error.message);
    return null;
  } finally {
    if (chrome) {
      await chrome.kill();
    }
  }
}

/**
 * Formats Lighthouse scores with emoji indicators
 */
function formatScore(score: number): string {
  if (score >= 90) return `🟢 ${score}`;
  if (score >= 50) return `🟡 ${score}`;
  return `🔴 ${score}`;
}

/**
 * Formats a metric value with appropriate units
 */
function formatMetric(value: number | undefined, unit: string): string {
  if (value === undefined) return "N/A";
  if (unit === "ms") return `${Math.round(value)}ms`;
  if (unit === "s") return `${(value / 1000).toFixed(2)}s`;
  return `${value.toFixed(2)}`;
}

/**
 * Formats Lighthouse results as markdown
 */
function formatLighthouseResults(results: {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
  metrics?: {
    firstContentfulPaint?: number;
    largestContentfulPaint?: number;
    totalBlockingTime?: number;
    cumulativeLayoutShift?: number;
    speedIndex?: number;
  };
}): string {
  const { performance, accessibility, bestPractices, seo, metrics } = results;

  const metricsSection = metrics
    ? `
      ### Performance Metrics
      - **First Contentful Paint**: ${formatMetric(metrics.firstContentfulPaint, "ms")}
      - **Largest Contentful Paint**: ${formatMetric(metrics.largestContentfulPaint, "ms")}
      - **Total Blocking Time**: ${formatMetric(metrics.totalBlockingTime, "ms")}
      - **Cumulative Layout Shift**: ${formatMetric(metrics.cumulativeLayoutShift, "")}
      - **Speed Index**: ${formatMetric(metrics.speedIndex, "ms")}
    `
    : "";

  return `
    ## 🔍 Lighthouse Audit Results

    ⏳ Rendering Lighthouse score...

      ### Scores
      - **Performance**: ${formatScore(performance)}
      - **Accessibility**: ${formatScore(accessibility)}
      - **Best Practices**: ${formatScore(bestPractices)}
      - **SEO**: ${formatScore(seo)}

      ${metricsSection}

      *Audit completed automatically after theme deployment*
  `;
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
      "Content-Type": "application/json",
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
            httpMethod: "POST",
          },
        ],
      },
    }),
  });

  if (!stagedUploadResponse.ok) {
    const text = await stagedUploadResponse.text().catch(() => "");
    throw new Error(
      `[${owner}/${repo}] stagedUploadsCreate failed: ${stagedUploadResponse.status} ${stagedUploadResponse.statusText} ${text}`
    );
  }

  const stagedUploadResult =
    (await stagedUploadResponse.json()) as StagedUploadResponse;

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
      `Failed to create staged upload: ${JSON.stringify(
        stagedCreate.userErrors
      )}`
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
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text().catch(() => "");
    throw new Error(
      `Failed to upload file to staged upload URL: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`
    );
  }

  console.log(
    `[${owner}/${repo}] Successfully uploaded file to staged upload URL`
  );

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
      console.log(`[${owner}/${repo}] Updating existing preview theme ${existingThemeId}...`);

    themeId = existingThemeId;

    const createResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json",
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
            name: `Tryzens/Preview - PR #${pr.number} (${formatDateDDMMYY()})`,
          },
        },
      }),
    });

    const updateResult = (await createResponse.json()) as {
      data: {
        themeUpdate: {
          theme: {
            id: string;
            name: string;
          };
          userErrors: { field: string[]; message: string }[];
        };
      };
    };

    console.log(
      `[${owner}/${repo}] Update result:`,
      JSON.stringify(updateResult, null, 2)
    );

    if (updateResult.data.themeUpdate.userErrors.length > 0) {
      const errors = updateResult.data.themeUpdate.userErrors;
      throw new Error(`Failed to update theme: ${JSON.stringify(errors)}`);
    }

    const themeGid = updateResult.data.themeUpdate.theme.id;
    if (!themeGid) throw new Error("Failed to get theme ID from update response");
    themeId = themeGid.split("/").pop() || "";

    themeUrl = `https://${storeName}.myshopify.com/admin/themes/${themeId}`;
    console.log(
      `[${owner}/${repo}] Successfully updated preview theme ${themeId}`
    );

    await saveThemeIdToDescription(octokit, owner, repo, pr.number, themeId);

    // Poll theme status every 5 seconds until it's ready
    await waitForThemeReady(
      graphqlUrl,
      adminApiToken,
      themeId,
      storeName,
      owner,
      repo
    );

    // Run Lighthouse audit on the preview theme
    const previewUrl = `https://${storeName}.myshopify.com?preview_theme_id=${themeId}`;
    const lighthouseResults = await runLighthouseAudit(owner, repo, previewUrl);

    await commentPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number,
      themeId,
      storeName,
      "update",
      lighthouseResults || undefined
    );
    } else {
      console.log(`[${owner}/${repo}] Creating new preview theme...`);

    const createResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json",
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
          name: `Tryzens/Preview - PR #${pr.number} (${formatDateDDMMYY()})`,
          source: resourceUrl,
        },
      }),
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

    await saveThemeIdToDescription(octokit, owner, repo, pr.number, themeId);

    // Poll theme status every 5 seconds until it's ready
    await waitForThemeReady(
      graphqlUrl,
      adminApiToken,
      themeId,
      storeName,
      owner,
      repo
    );

    // Run Lighthouse audit on the preview theme
    const previewUrl = `https://${storeName}.myshopify.com?preview_theme_id=${themeId}`;
    const lighthouseResults = await runLighthouseAudit(owner, repo, previewUrl);

    await commentPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number,
      themeId,
      storeName,
      "create",
      lighthouseResults || undefined
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
      console.log(`[${owner}/${repo}] No store name found, skipping theme deletion`);
      return;
    }

    const adminApiToken = await getAdminApiToken(octokit, pr, owner, repo);
    if (!adminApiToken) {
      console.log(`[${owner}/${repo}] No admin API token found, skipping theme deletion`);
      return;
    }

    const existingThemeId = await getExistingPreviewThemeId(
      octokit,
      owner,
      repo,
      pr.number
    );

    if (!existingThemeId) {
      console.log(`[${owner}/${repo}] No preview theme ID found in PR description, skipping deletion`);
      return;
    }

    const graphqlUrl = `https://${storeName}.myshopify.com/admin/api/2025-10/graphql.json`;

    console.log(`[${owner}/${repo}] Deleting preview theme ${existingThemeId}...`);

    const deleteResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": adminApiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          mutation themeDelete($id: ID!) {
            themeDelete(id: $id) {
              deletedThemeId
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          id: `gid://shopify/OnlineStoreTheme/${existingThemeId}`,
        },
      }),
    });

    if (!deleteResponse.ok) {
      const text = await deleteResponse.text();
      throw new Error(
        `themeDelete failed: ${deleteResponse.status} ${deleteResponse.statusText} ${text}`
      );
    }

    const deleteResult = (await deleteResponse.json()) as {
      data?: {
        themeDelete: {
          deletedThemeId: string | null;
          userErrors: { field: string[]; message: string }[];
        };
      };
      errors?: { message: string }[];
    };

    console.log(`[${owner}/${repo}] Delete result:`, JSON.stringify(deleteResult, null, 2));

    if (deleteResult.errors?.length) {
      throw new Error(`Failed to delete theme (top-level errors): ${JSON.stringify(deleteResult.errors)}`);
    }

    const themeDelete = deleteResult.data?.themeDelete;
    if (!themeDelete) {
      throw new Error("themeDelete missing in response");
    }

    if (themeDelete.userErrors.length > 0) {
      const errors = themeDelete.userErrors;
      throw new Error(`Failed to delete theme: ${JSON.stringify(errors)}`);
    }

    console.log(`[${owner}/${repo}] Successfully deleted preview theme ${existingThemeId}`);

    // Comment on PR about successful deletion
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pr.number,
        body: `✅ Preview theme ${existingThemeId} has been deleted successfully.`,
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
    console.error(`[${owner}/${repo}] Error handling preview generation, please contact a senior developer.`, error.message);

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
