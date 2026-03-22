const DEFAULT_SETTINGS = {
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage: "ko",
  showOriginalOnHover: true,
  autoTranslateLanguages: [],
  alwaysTranslateSites: []
};

const MODEL_NAME = "gemini-3.1-flash-lite-preview";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
const MODEL_INFO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}`;
const MAX_CHUNK_SEGMENTS = 40;
const MAX_CHUNK_CHARACTERS = 6000;
const MAX_SEGMENT_CHARACTERS = 1400;
const MIN_SPLIT_SEGMENT_CHARACTERS = 220;
const MIN_SPLIT_POINT_RATIO = 0.55;
const TRANSLATION_RETRY_LIMIT = 2;
const COLLECTION_RETRY_DELAYS_MS = [0, 400, 1000];
const STATUS_CHECK_TIMEOUT_MS = 8000;
const activeTranslations = new Map();
const tabPageRevisionByTabId = new Map();
const translationStatusByTabId = new Map();
let translationRunIdSequence = 0;

const LANGUAGE_NAMES = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  vi: "Vietnamese"
};

chrome.runtime.onInstalled.addListener(async () => {
  const currentSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(currentSettings);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }

  tabPageRevisionByTabId.set(tabId, getTabPageRevision(tabId) + 1);
  clearTranslationStatus(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTranslations.delete(tabId);
  tabPageRevisionByTabId.delete(tabId);
  clearTranslationStatus(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "알 수 없는 오류가 발생했어요."
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_TRANSLATION":
      return startTranslation(message.tabId);
    case "CHECK_API_STATUS":
      return checkApiStatus(message.apiKey);
    case "GET_TRANSLATION_STATUS":
      return getTranslationStatus(message.tabId);
    case "PAGE_READY":
      return maybeAutoTranslate(sender, message);
    default:
      return { ok: false, error: "지원하지 않는 요청이에요." };
  }
}

async function startTranslation(tabId) {
  if (!tabId) {
    return { ok: false, error: "현재 탭을 찾지 못했어요." };
  }

  const settings = await getSettings();
  const pageUrl = await getTabUrl(tabId);

  return runTranslation(tabId, settings, {
    mode: "manual",
    pageUrl
  });
}

function getTranslationStatus(tabId) {
  if (!tabId) {
    return { ok: true, status: null };
  }

  const status = translationStatusByTabId.get(tabId) ?? null;

  if (status && (status.pageRevision ?? 0) < getTabPageRevision(tabId)) {
    translationStatusByTabId.delete(tabId);
    return { ok: true, status: null };
  }

  return {
    ok: true,
    status
  };
}

async function maybeAutoTranslate(sender, message) {
  const tabId = sender.tab?.id;
  const settings = await getSettings();

  if (!tabId || !settings.apiKey) {
    return { ok: true, skipped: true };
  }

  if (!message?.autoTranslateSafe) {
    return { ok: true, skipped: true };
  }

  const tabUrl = sender.tab?.url ?? message?.url ?? "";
  const detectedLanguage = await detectTabLanguage(tabId, message?.pageLanguage ?? "");
  const hostname = getHostname(tabUrl);
  const shouldTranslateSite = hostname
    ? settings.alwaysTranslateSites.includes(hostname)
    : false;
  const shouldTranslateLanguage = matchesStoredLanguage(
    detectedLanguage,
    settings.autoTranslateLanguages
  );

  if (!shouldTranslateSite && !shouldTranslateLanguage) {
    return { ok: true, skipped: true };
  }

  return runTranslation(tabId, settings, {
    mode: "auto",
    pageUrl: tabUrl
  });
}

async function checkApiStatus(apiKey) {
  const normalizedApiKey = String(apiKey ?? "").trim();

  if (!normalizedApiKey) {
    return {
      ok: false,
      error: "API 키를 먼저 입력해 주세요."
    };
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(MODEL_INFO_URL, {
      method: "GET",
      headers: {
        "x-goog-api-key": normalizedApiKey
      },
      signal: controller.signal
    });

    const payload = await readJsonResponse(response);

    if (!response.ok) {
      return {
        ok: false,
        error: getApiErrorMessage(payload)
      };
    }

    const generationMethods = Array.isArray(payload?.supportedGenerationMethods)
      ? payload.supportedGenerationMethods
      : [];

    if (!generationMethods.includes("generateContent")) {
      return {
        ok: false,
        error: "이 모델은 현재 번역 요청에 바로 사용할 수 없어요."
      };
    }

    return {
      ok: true,
      status: "online",
      latencyMs: Date.now() - startedAt,
      modelName: payload?.displayName || payload?.name || MODEL_NAME
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: false,
        error: "API 상태 확인 시간이 초과됐어요."
      };
    }

    return {
      ok: false,
      error: "Gemini 서버에 연결하지 못했어요."
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function runTranslation(tabId, settings, options = {}) {
  const mode = options.mode ?? "manual";
  const pageUrl = String(options.pageUrl ?? "");
  const pageRevision = getTabPageRevision(tabId);

  if (!settings.apiKey) {
    return { ok: false, error: "Gemini API 키를 먼저 입력해 주세요." };
  }

  if (settings.sourceLanguage === settings.targetLanguage) {
    return { ok: false, error: "원문 언어와 번역 언어가 같아요." };
  }

  const activeTranslation = activeTranslations.get(tabId);

  if (
    activeTranslation?.pageUrl === pageUrl &&
    activeTranslation?.pageRevision === pageRevision
  ) {
    if (mode === "auto") {
      return { ok: true, skipped: true, reason: "already-running" };
    }

    return { ok: false, error: "이미 번역 중이에요. 잠시만 기다려 주세요." };
  }

  const runId = ++translationRunIdSequence;
  updateTranslationStatus(tabId, {
    runId,
    pageUrl,
    pageRevision,
    mode,
    state: "running",
    stage: "queued",
    batchCount: 0,
    translatedCount: 0,
    error: "",
    updatedAt: Date.now()
  });

  const task = executeTranslation(tabId, settings, {
    runId,
    pageUrl,
    pageRevision,
    mode
  }).finally(() => {
    if (activeTranslations.get(tabId)?.runId === runId) {
      activeTranslations.delete(tabId);
    }
  });

  activeTranslations.set(tabId, {
    runId,
    pageUrl,
    pageRevision,
    task
  });

  return task;
}

async function executeTranslation(tabId, settings, context) {
  let startIndex = 0;
  let batchCount = 0;
  let translatedCount = 0;
  let pageLanguageHint = "";
  let snapshotId = "";

  try {
    while (true) {
      let collected;

      try {
        collected = await collectPageTextWithRetry(tabId, {
          startIndex,
          snapshotId,
          expectedPageUrl: context.pageUrl
        });
      } catch (error) {
        return failTranslation(tabId, context, {
          batchCount,
          translatedCount,
          error: "현재 페이지에서 번역을 실행할 수 없어요."
        });
      }

      if (!collected?.ok) {
        return failTranslation(tabId, context, {
          batchCount,
          translatedCount,
          error: collected?.error ?? "페이지 텍스트를 읽지 못했어요."
        });
      }

      if (context.mode === "auto" && !collected.autoTranslateSafe) {
        clearTranslationStatus(tabId, context.runId);

        return {
          ok: true,
          skipped: true,
          reason: "unsafe-page"
        };
      }

      snapshotId = collected.snapshotId ?? snapshotId;

      if (!Array.isArray(collected.segments) || collected.segments.length === 0) {
        if (batchCount > 0) {
          break;
        }

        return failTranslation(tabId, context, {
          batchCount,
          translatedCount,
          error: "번역할 텍스트를 찾지 못했어요."
        });
      }

      if (!pageLanguageHint) {
        pageLanguageHint = await detectTabLanguage(tabId, collected.pageLanguage);
      }

      batchCount += 1;
      updateTranslationStatus(tabId, {
        runId: context.runId,
        pageUrl: context.pageUrl,
        pageRevision: context.pageRevision,
        state: "running",
        stage: "translating",
        batchCount,
        translatedCount,
        updatedAt: Date.now()
      });
      sendTranslationProgress(tabId, {
        pageUrl: context.pageUrl,
        pageRevision: context.pageRevision,
        stage: "translating",
        batchCount,
        translatedCount
      });

      const preparedSegments = prepareSegmentsForTranslation(collected.segments);
      const translatedParts = [];

      for (const chunk of createChunks(preparedSegments)) {
        const translatedChunk = await translateChunk(chunk, settings, pageLanguageHint);
        translatedParts.push(...translatedChunk);
      }

      const translatedSegments = mergeTranslatedSegments(collected.segments, translatedParts);
      const applyResult = await applyTranslationsToPage(tabId, translatedSegments, settings, {
        snapshotId,
        expectedPageUrl: context.pageUrl
      });

      if (!applyResult.ok) {
        return failTranslation(tabId, context, {
          batchCount,
          translatedCount,
          error: applyResult.error
        });
      }

      if (applyResult.retryRecommended) {
        return failTranslation(tabId, context, {
          batchCount,
          translatedCount,
          error: "페이지가 바뀌어서 일부 문단을 적용하지 못했어요. 다시 시도해 주세요."
        });
      }

      translatedCount += translatedSegments.length;

      if (!collected.hasMore) {
        break;
      }

      startIndex = collected.nextIndex;
      updateTranslationStatus(tabId, {
        runId: context.runId,
        pageUrl: context.pageUrl,
        pageRevision: context.pageRevision,
        state: "running",
        stage: "continuing",
        batchCount,
        translatedCount,
        updatedAt: Date.now()
      });
      sendTranslationProgress(tabId, {
        pageUrl: context.pageUrl,
        pageRevision: context.pageRevision,
        stage: "continuing",
        batchCount,
        translatedCount
      });
    }
  } catch (error) {
    return failTranslation(tabId, context, {
      batchCount,
      translatedCount,
      error: error instanceof Error ? error.message : "번역을 완료하지 못했어요."
    });
  }

  sendTranslationProgress(tabId, {
    pageUrl: context.pageUrl,
    pageRevision: context.pageRevision,
    stage: "complete",
    batchCount,
    translatedCount
  });
  updateTranslationStatus(tabId, {
    runId: context.runId,
    pageUrl: context.pageUrl,
    pageRevision: context.pageRevision,
    state: "completed",
    stage: "complete",
    batchCount,
    translatedCount,
    error: "",
    updatedAt: Date.now()
  });

  return {
    ok: true,
    translatedCount,
    batchCount,
    truncated: false
  };
}

async function collectPageTextWithRetry(tabId, options = {}) {
  const {
    startIndex = 0,
    snapshotId = "",
    expectedPageUrl = ""
  } = options;
  let lastCollected = null;
  let lastError = null;

  for (const delayMs of COLLECTION_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await wait(delayMs);
    }

    try {
      const collected = await chrome.tabs.sendMessage(tabId, {
        type: "COLLECT_PAGE_TEXT",
        startIndex,
        snapshotId,
        expectedPageUrl
      });
      lastCollected = collected;

      if (collected?.ok === false) {
        return collected;
      }

      if (Array.isArray(collected?.segments) && collected.segments.length > 0) {
        return collected;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastCollected) {
    return lastCollected;
  }

  throw lastError ?? new Error("페이지 텍스트를 읽지 못했어요.");
}

async function applyTranslationsToPage(tabId, translations, settings, options = {}) {
  const {
    snapshotId = "",
    expectedPageUrl = ""
  } = options;

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "APPLY_TRANSLATION",
      translations,
      showOriginalOnHover: settings.showOriginalOnHover,
      snapshotId,
      expectedPageUrl
    });

    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error ?? "페이지에 번역 결과를 적용하지 못했어요."
      };
    }

    return {
      ok: true,
      retryRecommended: Boolean(result?.retryRecommended)
    };
  } catch (error) {
    return {
      ok: false,
      error: "페이지에 번역 결과를 적용하지 못했어요."
    };
  }
}

function prepareSegmentsForTranslation(segments) {
  return segments.flatMap((segment) => {
    const pieces = splitSegmentText(segment.text);

    return pieces.map((text, index) => ({
      id: pieces.length === 1 ? segment.id : `${segment.id}__part-${index + 1}`,
      sourceId: segment.id,
      partIndex: index,
      text,
      type: segment.type ?? "paragraph"
    }));
  });
}

function splitSegmentText(text) {
  if (text.length <= MAX_SEGMENT_CHARACTERS) {
    return [text];
  }

  const parts = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    const remainingCharacters = text.length - startIndex;

    if (remainingCharacters <= MAX_SEGMENT_CHARACTERS) {
      parts.push(text.slice(startIndex));
      break;
    }

    const maxEnd = startIndex + MAX_SEGMENT_CHARACTERS;
    const minEnd = startIndex + Math.floor(MAX_SEGMENT_CHARACTERS * MIN_SPLIT_POINT_RATIO);
    const splitPoint = findSplitPoint(text, minEnd, maxEnd);

    parts.push(text.slice(startIndex, splitPoint));
    startIndex = splitPoint;
  }

  return mergeShortSplitParts(parts);
}

// Prefer boundaries that preserve reading flow before falling back to plain whitespace.
function findSplitPoint(text, minEnd, maxEnd) {
  const splitStrategies = [
    findParagraphSplitPoint,
    findListBoundarySplitPoint,
    findSentenceSplitPoint,
    findLineBreakSplitPoint,
    findClauseSplitPoint,
    findWhitespaceSplitPoint
  ];

  for (const findCandidate of splitStrategies) {
    const splitPoint = findCandidate(text, minEnd, maxEnd);
    const safeSplitPoint = Math.min(splitPoint, maxEnd);

    if (safeSplitPoint > minEnd) {
      return safeSplitPoint;
    }
  }

  return maxEnd;
}

function findParagraphSplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    if (text[index - 1] === "\n" && text[index] === "\n") {
      return index + 1;
    }
  }

  return -1;
}

function findListBoundarySplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    if (text[index] !== "\n") {
      continue;
    }

    if (/^(?:[-*•]\s|\d+[.)]\s|\[[ xX]\]\s)/u.test(text.slice(index + 1, index + 12))) {
      return index + 1;
    }
  }

  return -1;
}

function findSentenceSplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    const currentCharacter = text[index] ?? "";
    const previousCharacter = text[index - 1] ?? "";

    if ((currentCharacter === "\n" || /\s/u.test(currentCharacter)) && /[.!?。！？]/u.test(previousCharacter)) {
      return index;
    }

    if (/[.!?。！？]/u.test(currentCharacter)) {
      return index + 1;
    }
  }

  return -1;
}

function findLineBreakSplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    if (text[index] === "\n") {
      return index + 1;
    }
  }

  return -1;
}

function findClauseSplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    const currentCharacter = text[index] ?? "";
    const previousCharacter = text[index - 1] ?? "";

    if ((currentCharacter === "\n" || /\s/u.test(currentCharacter)) && /[;:]/u.test(previousCharacter)) {
      return index;
    }
  }

  return -1;
}

function findWhitespaceSplitPoint(text, minEnd, maxEnd) {
  for (let index = maxEnd; index >= minEnd; index -= 1) {
    if (/\s/u.test(text[index] ?? "")) {
      return index + 1;
    }
  }

  return -1;
}

function mergeShortSplitParts(parts) {
  const mergedParts = [];

  for (const part of parts.filter(Boolean)) {
    if (mergedParts.length === 0) {
      mergedParts.push(part);
      continue;
    }

    const previousPart = mergedParts[mergedParts.length - 1];

    if (shouldMergeSplitParts(previousPart, part)) {
      mergedParts[mergedParts.length - 1] = previousPart + part;
      continue;
    }

    mergedParts.push(part);
  }

  return mergedParts;
}

function shouldMergeSplitParts(previousPart, nextPart) {
  const previousCoreLength = previousPart.trim().length;
  const nextCoreLength = nextPart.trim().length;

  if (
    previousCoreLength >= MIN_SPLIT_SEGMENT_CHARACTERS &&
    nextCoreLength >= MIN_SPLIT_SEGMENT_CHARACTERS
  ) {
    return false;
  }

  return previousPart.length + nextPart.length <= MAX_SEGMENT_CHARACTERS;
}

function createChunks(segments) {
  const chunks = [];
  let currentChunk = [];
  let currentCharacters = 0;

  for (const segment of segments) {
    const nextCharacters = currentCharacters + segment.text.length;
    const shouldSplit =
      currentChunk.length >= MAX_CHUNK_SEGMENTS ||
      (currentChunk.length > 0 && nextCharacters > MAX_CHUNK_CHARACTERS);

    if (shouldSplit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCharacters = 0;
    }

    currentChunk.push(segment);
    currentCharacters += segment.text.length;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function translateChunk(chunk, settings, pageLanguage) {
  let lastError = null;

  for (let attempt = 1; attempt <= TRANSLATION_RETRY_LIMIT; attempt += 1) {
    try {
      return await translateChunkOnce(chunk, settings, pageLanguage, attempt);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("번역을 완료하지 못했어요.");
}

async function translateChunkOnce(chunk, settings, pageLanguage, attempt) {
  const prompt = buildPrompt(chunk, settings, pageLanguage, attempt);
  const requestBody = {
    systemInstruction: {
      parts: [
        {
          text: "You are a translation engine for webpage text. Return only valid JSON that matches the provided schema."
        }
      ]
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingLevel: "minimal"
      },
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          translations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string"
                },
                translatedText: {
                  type: "string"
                }
              },
              required: ["id", "translatedText"]
            }
          }
        },
        required: ["translations"]
      }
    }
  };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": settings.apiKey
    },
    body: JSON.stringify(requestBody)
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload));
  }

  const responseText = getResponseText(payload);

  if (!responseText) {
    throw new Error("Gemini가 번역 결과를 비워서 돌려줬어요.");
  }

  let parsed;

  try {
    parsed = JSON.parse(stripCodeFence(responseText));
  } catch (error) {
    throw new Error("Gemini 응답을 해석하지 못했어요.");
  }

  return mapValidatedTranslations(chunk, parsed);
}

function buildPrompt(chunk, settings, pageLanguage, attempt) {
  const sourceLanguage = getSourceLanguageInstruction(settings.sourceLanguage, pageLanguage);
  const targetLanguage = getLanguageName(settings.targetLanguage);
  const inputPayload = chunk.map((segment) => ({
    id: segment.id,
    type: segment.type ?? "paragraph",
    text: segment.text
  }));

  const lines = [
    `Translate each item from ${sourceLanguage} to ${targetLanguage}.`,
    "Rules:",
    `- The translations array must contain exactly ${chunk.length} items.`,
    "- Return one translatedText value for every id.",
    "- Keep each id exactly the same.",
    "- Use the type field only as a webpage context hint.",
    "- Keep button-like, label, and menu text short.",
    "- Keep headings concise and readable.",
    "- Do not add explanations or notes.",
    "- Preserve punctuation, list markers, and line breaks when possible.",
    "- If a translation is identical to the source text, still return it.",
    "- If a string is code, a URL, an email address, a file path, or an identifier that should stay unchanged, return it as-is.",
    "- Return JSON only."
  ];

  if (attempt > 1) {
    lines.push("- The previous response missed or malformed some ids. Double-check every id before answering.");
  }

  lines.push("Input JSON:");
  lines.push(JSON.stringify(inputPayload));

  return lines.join("\n");
}

function mapValidatedTranslations(chunk, parsed) {
  const translatedById = new Map();

  if (Array.isArray(parsed?.translations)) {
    for (const item of parsed.translations) {
      if (typeof item?.id !== "string" || typeof item?.translatedText !== "string") {
        continue;
      }

      translatedById.set(item.id, item.translatedText);
    }
  }

  const missingIds = [];
  const translatedItems = chunk.map((segment) => {
    const translatedText = translatedById.get(segment.id);

    if (!isUsableTranslationText(translatedText)) {
      missingIds.push(segment.id);
    }

    return {
      ...segment,
      translatedText: normalizeChunkTranslationText(translatedText, segment.text)
    };
  });

  if (missingIds.length > 0) {
    throw new Error("Gemini 응답에 일부 번역이 빠졌어요.");
  }

  return translatedItems;
}

function isUsableTranslationText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function normalizeChunkTranslationText(value, fallbackText) {
  if (!isUsableTranslationText(value)) {
    return fallbackText;
  }

  return value.replace(/\r\n/g, "\n");
}

function mergeTranslatedSegments(originalSegments, translatedParts) {
  const partsBySourceId = new Map();

  for (const part of translatedParts) {
    const sourceId = part.sourceId ?? part.id;

    if (!partsBySourceId.has(sourceId)) {
      partsBySourceId.set(sourceId, []);
    }

    partsBySourceId.get(sourceId).push(part);
  }

  return originalSegments.map((segment) => {
    const matchedParts = partsBySourceId.get(segment.id);

    if (!Array.isArray(matchedParts) || matchedParts.length === 0) {
      throw new Error("번역 결과와 본문을 다시 연결하지 못했어요.");
    }

    const orderedParts = matchedParts
      .slice()
      .sort((left, right) => (left.partIndex ?? 0) - (right.partIndex ?? 0));

    return {
      id: segment.id,
      translatedText: orderedParts.map((part) => part.translatedText).join("")
    };
  });
}

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const targetLanguage =
    settings.targetLanguage && settings.targetLanguage !== "auto"
      ? settings.targetLanguage
      : DEFAULT_SETTINGS.targetLanguage;

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    targetLanguage,
    autoTranslateLanguages: Array.isArray(settings.autoTranslateLanguages)
      ? settings.autoTranslateLanguages.filter((language) => language !== "auto")
      : [],
    alwaysTranslateSites: Array.isArray(settings.alwaysTranslateSites)
      ? settings.alwaysTranslateSites
      : []
  };
}

function getLanguageName(code) {
  return LANGUAGE_NAMES[code] ?? code;
}

function getSourceLanguageInstruction(sourceLanguage, pageLanguage) {
  if (sourceLanguage !== "auto") {
    return getLanguageName(sourceLanguage);
  }

  const normalizedPageLanguage = normalizeLanguageCode(pageLanguage);

  if (normalizedPageLanguage) {
    return `the auto-detected source language (page language hint: ${normalizedPageLanguage})`;
  }

  return "the auto-detected source language";
}

function matchesStoredLanguage(pageLanguage, storedLanguages) {
  const normalizedPageLanguage = normalizeLanguageCode(pageLanguage);

  if (!normalizedPageLanguage) {
    return false;
  }

  return storedLanguages.some((language) => {
    const normalizedStoredLanguage = normalizeLanguageCode(language);
    return normalizedStoredLanguage && normalizedStoredLanguage === normalizedPageLanguage;
  });
}

function normalizeLanguageCode(code) {
  if (!code) {
    return "";
  }

  const normalized = String(code).trim().toLowerCase().replace(/_/g, "-");

  if (
    normalized.startsWith("zh-cn") ||
    normalized.startsWith("zh-hans") ||
    normalized.startsWith("zh-sg")
  ) {
    return "zh-cn";
  }

  if (
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hant") ||
    normalized.startsWith("zh-hk") ||
    normalized.startsWith("zh-mo")
  ) {
    return "zh-tw";
  }

  return normalized.split("-")[0];
}

function getHostname(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch (error) {
    return "";
  }
}

async function getTabUrl(tabId) {
  if (!tabId) {
    return "";
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ?? "";
  } catch (error) {
    return "";
  }
}

async function detectTabLanguage(tabId, fallbackLanguage = "") {
  if (!tabId) {
    return fallbackLanguage;
  }

  try {
    const detectedLanguage = await chrome.tabs.detectLanguage(tabId);

    if (detectedLanguage && detectedLanguage !== "und") {
      return detectedLanguage;
    }
  } catch (error) {
    // Fall back to the page-provided language hint.
  }

  return fallbackLanguage;
}

function getResponseText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
}

function stripCodeFence(text) {
  return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
}

function getApiErrorMessage(payload) {
  const message = payload?.error?.message;

  if (!message) {
    return "Gemini API 호출이 실패했어요.";
  }

  if (message.toLowerCase().includes("api key")) {
    return "API 키를 다시 확인해 주세요.";
  }

  return message;
}

async function readJsonResponse(response) {
  const rawText = await response.text();

  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    return {
      error: {
        message: rawText
      }
    };
  }
}

function sendTranslationProgress(tabId, payload) {
  if ((payload.pageRevision ?? 0) < getTabPageRevision(tabId)) {
    return;
  }

  void chrome.runtime.sendMessage({
    type: "TRANSLATION_PROGRESS",
    tabId,
    ...payload
  }).catch(() => {
    // The popup may be closed.
  });
}

function wait(delayMs) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function updateTranslationStatus(tabId, patch) {
  if (!tabId) {
    return;
  }

  const currentPageRevision = getTabPageRevision(tabId);
  const existingStatus = translationStatusByTabId.get(tabId);
  const previousRunId = existingStatus?.runId ?? 0;
  const nextRunId = patch.runId ?? previousRunId;
  const nextPageRevision = patch.pageRevision ?? existingStatus?.pageRevision ?? currentPageRevision;

  if (nextPageRevision < currentPageRevision) {
    return;
  }

  if (nextRunId < previousRunId) {
    return;
  }

  const previousStatus = translationStatusByTabId.get(tabId) ?? {
    runId: 0,
    pageUrl: "",
    pageRevision: currentPageRevision,
    mode: "manual",
    state: "idle",
    stage: "",
    batchCount: 0,
    translatedCount: 0,
    error: "",
    updatedAt: 0
  };

  translationStatusByTabId.set(tabId, {
    ...previousStatus,
    ...patch
  });
}

function clearTranslationStatus(tabId, runId) {
  if (!tabId) {
    return;
  }

  const currentStatus = translationStatusByTabId.get(tabId);

  if (!currentStatus) {
    return;
  }

  if ((runId ?? currentStatus.runId) < (currentStatus.runId ?? 0)) {
    return;
  }

  if (typeof runId === "number" && (currentStatus.runId ?? 0) !== runId) {
    return;
  }

  translationStatusByTabId.delete(tabId);
}

function failTranslation(tabId, context, details) {
  const errorMessage = details.error || "번역을 완료하지 못했어요.";

  updateTranslationStatus(tabId, {
    runId: context.runId,
    pageUrl: context.pageUrl,
    pageRevision: context.pageRevision,
    state: "failed",
    stage: "error",
    batchCount: details.batchCount ?? 0,
    translatedCount: details.translatedCount ?? 0,
    error: errorMessage,
    updatedAt: Date.now()
  });
  sendTranslationProgress(tabId, {
    pageUrl: context.pageUrl,
    pageRevision: context.pageRevision,
    stage: "error",
    batchCount: details.batchCount ?? 0,
    translatedCount: details.translatedCount ?? 0,
    error: errorMessage
  });

  return {
    ok: false,
    error: errorMessage
  };
}

function getTabPageRevision(tabId) {
  return tabPageRevisionByTabId.get(tabId) ?? 0;
}
