import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const enPath = path.join(rootDir, "_locales", "en", "messages.json");
const koPath = path.join(rootDir, "_locales", "ko", "messages.json");

const assetChecks = [
  {
    label: "popup.html",
    filePath: path.join(rootDir, "popup.html"),
    requiredSnippets: [
      "<!doctype html>",
      "Context Translator",
      "↔",
      "Show original on hover"
    ]
  },
  {
    label: "README.md",
    filePath: path.join(rootDir, "README.md"),
    requiredSnippets: [
      "**Language:** English | [Korean](./README.ko.md)",
      "# Context Translator",
      "## Quick Start",
      "node scripts/validate-locales.mjs"
    ]
  },
  {
    label: "README.ko.md",
    filePath: path.join(rootDir, "README.ko.md"),
    requiredSnippets: [
      "**언어:** [English](./README.md) | 한국어",
      "# Context Translator",
      "## 빠른 시작",
      "node scripts/validate-locales.mjs"
    ]
  }
];

const [enLocale, koLocale, ...assetContents] = await Promise.all([
  readLocale(enPath),
  readLocale(koPath),
  ...assetChecks.map((asset) => readText(asset.filePath))
]);

const issues = [
  ...compareLocaleKeys("en", enLocale, "ko", koLocale),
  ...compareLocaleKeys("ko", koLocale, "en", enLocale),
  ...comparePlaceholders("en", enLocale, "ko", koLocale),
  ...comparePlaceholders("ko", koLocale, "en", enLocale),
  ...validateMessages("en", enLocale),
  ...validateMessages("ko", koLocale),
  ...assetChecks.flatMap((asset, index) => validateAssetText(asset, assetContents[index]))
];

if (issues.length > 0) {
  console.error("Validation failed:");

  for (const issue of issues) {
    console.error(`- ${issue}`);
  }

  process.exit(1);
}

console.log("Locale and asset validation passed.");

async function readLocale(filePath) {
  const rawText = await readFile(filePath, "utf8");
  return JSON.parse(rawText);
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

function compareLocaleKeys(sourceName, sourceLocale, targetName, targetLocale) {
  const issues = [];

  for (const key of Object.keys(sourceLocale)) {
    if (!Object.hasOwn(targetLocale, key)) {
      issues.push(`Missing key '${key}' in ${targetName} locale (present in ${sourceName}).`);
    }
  }

  return issues;
}

function comparePlaceholders(sourceName, sourceLocale, targetName, targetLocale) {
  const issues = [];

  for (const [key, sourceEntry] of Object.entries(sourceLocale)) {
    const targetEntry = targetLocale[key];

    if (!targetEntry) {
      continue;
    }

    const sourcePlaceholders = Object.keys(sourceEntry.placeholders ?? {}).sort();
    const targetPlaceholders = Object.keys(targetEntry.placeholders ?? {}).sort();

    if (sourcePlaceholders.join("|") !== targetPlaceholders.join("|")) {
      issues.push(
        `Placeholder mismatch for '${key}' between ${sourceName} and ${targetName}.`
      );
    }
  }

  return issues;
}

function validateMessages(localeName, localeData) {
  const issues = [];

  for (const [key, entry] of Object.entries(localeData)) {
    if (typeof entry?.message !== "string" || entry.message.trim().length === 0) {
      issues.push(`Message '${key}' in ${localeName} locale is empty or missing.`);
      continue;
    }

    if (entry.message.includes("\uFFFD")) {
      issues.push(`Message '${key}' in ${localeName} locale contains a replacement character.`);
    }

    for (const placeholderName of Object.keys(entry.placeholders ?? {})) {
      const placeholderToken = `$${placeholderName.toUpperCase()}$`;

      if (!entry.message.toUpperCase().includes(placeholderToken)) {
        issues.push(
          `Placeholder '${placeholderName}' is not referenced in message '${key}' for ${localeName}.`
        );
      }
    }
  }

  return issues;
}

function validateAssetText(asset, text) {
  const issues = [];

  if (text.includes("\uFFFD")) {
    issues.push(`${asset.label} contains a replacement character.`);
  }

  if (/[?]쒓|[?]몄|[?]붴|[?]{2,}/u.test(text)) {
    issues.push(`${asset.label} appears to contain mojibake or placeholder question marks.`);
  }

  for (const snippet of asset.requiredSnippets) {
    if (!text.includes(snippet)) {
      issues.push(`${asset.label} is missing expected text: ${JSON.stringify(snippet)}.`);
    }
  }

  return issues;
}
