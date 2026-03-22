const TRANSLATED_CLASS_NAME = "context-translator__translated-text";
const TRANSLATED_MARKER_ATTRIBUTE = "data-context-translator";
const TRANSLATED_MARKER_VALUE = "translated";
const MAX_SEGMENTS = 180;
const MAX_TOTAL_CHARACTERS = 18000;
const AUTO_TRANSLATE_READY_DELAY_MS = 800;

const pageState = {
  autoTranslateTimer: null,
  snapshotSequence: 0,
  translationSnapshot: null
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "COLLECT_PAGE_TEXT") {
    collectPageText({
      startIndex: message.startIndex,
      snapshotId: message.snapshotId,
      expectedPageUrl: message.expectedPageUrl
    })
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "페이지 텍스트를 읽지 못했어요."
        });
      });

    return true;
  }

  if (message?.type === "APPLY_TRANSLATION") {
    sendResponse(
      applyTranslations(message.translations, Boolean(message.showOriginalOnHover), {
        snapshotId: message.snapshotId,
        expectedPageUrl: message.expectedPageUrl
      })
    );
    return false;
  }

  if (message?.type === "UPDATE_HOVER_MODE") {
    updateHoverMode(Boolean(message.enabled));
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

initializeAutoTranslateHooks();
scheduleAutoTranslateCheck();

async function collectPageText(options = {}) {
  if (!document.body) {
    return {
      ok: false,
      error: "페이지 본문을 아직 찾지 못했어요."
    };
  }

  const startIndex = Number.isInteger(options.startIndex) && options.startIndex > 0
    ? options.startIndex
    : 0;
  const expectedPageUrl = String(options.expectedPageUrl ?? "");

  if (expectedPageUrl && expectedPageUrl !== window.location.href) {
    return {
      ok: false,
      error: "페이지가 바뀌어서 번역을 중단했어요."
    };
  }

  const snapshot = getOrCreateTranslationSnapshot(String(options.snapshotId ?? ""));
  const batch = getSnapshotBatch(snapshot, startIndex);

  return {
    ok: true,
    snapshotId: snapshot.id,
    hasMore: batch.hasMore,
    nextIndex: batch.nextIndex,
    pageLanguage: detectPageLanguage(),
    autoTranslateSafe: isAutoTranslateSafe(),
    segments: batch.segments
  };
}

function applyTranslations(translations, showOriginalOnHover, options = {}) {
  const expectedPageUrl = String(options.expectedPageUrl ?? "");

  if (expectedPageUrl && expectedPageUrl !== window.location.href) {
    return {
      ok: false,
      error: "페이지가 바뀌어서 번역 결과를 적용하지 못했어요."
    };
  }

  const snapshot = getActiveTranslationSnapshot(String(options.snapshotId ?? ""));

  if (!snapshot) {
    return {
      ok: false,
      error: "페이지 상태가 바뀌어서 다시 번역이 필요해요."
    };
  }

  const safeTranslations = Array.isArray(translations) ? translations : [];
  let appliedCount = 0;
  let skippedCount = 0;

  for (const item of safeTranslations) {
    const collected = snapshot.nodesById.get(item.id);

    if (!collected || !collected.targetNode?.isConnected) {
      skippedCount += 1;
      continue;
    }

    const translatedText = normalizeTranslatedText(item.translatedText, collected.originalCore);
    const renderedText =
      collected.leadingWhitespace + translatedText + collected.trailingWhitespace;
    const wrapper =
      collected.targetType === "wrapper" && isOurTranslatedElement(collected.targetNode)
        ? collected.targetNode
        : document.createElement("span");

    wrapper.className = TRANSLATED_CLASS_NAME;
    wrapper.setAttribute(TRANSLATED_MARKER_ATTRIBUTE, TRANSLATED_MARKER_VALUE);
    wrapper.dataset.originalFull = collected.originalFull;
    wrapper.dataset.originalCore = collected.originalCore;
    wrapper.textContent = renderedText;

    if (showOriginalOnHover) {
      wrapper.title = collected.originalCore;
    } else {
      wrapper.removeAttribute("title");
    }

    if (collected.targetType === "wrapper") {
      appliedCount += 1;
      continue;
    } else {
      collected.targetNode.replaceWith(wrapper);
      appliedCount += 1;
    }
  }

  return {
    ok: true,
    appliedCount,
    skippedCount,
    retryRecommended: skippedCount > 0
  };
}

function updateHoverMode(enabled) {
  const translatedNodes = document.querySelectorAll(
    `[${TRANSLATED_MARKER_ATTRIBUTE}="${TRANSLATED_MARKER_VALUE}"]`
  );

  for (const node of translatedNodes) {
    if (enabled) {
      node.title = node.dataset.originalCore ?? "";
    } else {
      node.removeAttribute("title");
    }
  }
}

function restoreOriginalContent() {
  const translatedNodes = document.querySelectorAll(
    `[${TRANSLATED_MARKER_ATTRIBUTE}="${TRANSLATED_MARKER_VALUE}"]`
  );

  for (const node of translatedNodes) {
    const originalText = node.dataset.originalFull ?? node.textContent ?? "";
    node.replaceWith(document.createTextNode(originalText));
  }
}

function shouldSkipTextNode(textNode) {
  if (!(textNode instanceof Text)) {
    return true;
  }

  const parent = textNode.parentElement;

  if (!parent || isOurTranslatedElement(parent)) {
    return true;
  }

  if (isExcludedElement(parent)) {
    return true;
  }

  if (!isVisible(parent)) {
    return true;
  }

  const value = textNode.nodeValue ?? "";
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return true;
  }

  if (!containsTranslatableText(normalizedValue)) {
    return true;
  }

  return shouldPreserveSourceText(normalizedValue, parent);
}

function isExcludedElement(element) {
  const excludedTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "CODE",
    "PRE",
    "SVG",
    "CANVAS"
  ]);

  if (excludedTags.has(element.tagName)) {
    return true;
  }

  if (element.isContentEditable) {
    return true;
  }

  return Boolean(
    element.closest(
      "script, style, noscript, textarea, input, select, option, code, pre, svg, canvas"
    )
  );
}

function isVisible(element) {
  if (element.closest("[aria-hidden='true']")) {
    return false;
  }

  const style = window.getComputedStyle(element);

  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  return element.getClientRects().length > 0;
}

function containsTranslatableText(value) {
  return /[\p{L}]/u.test(value);
}

// Skip only strong "keep as-is" patterns so short UI labels still reach the model.
function shouldPreserveSourceText(value, parentElement) {
  if (isLikelyUrl(value) || isLikelyEmail(value) || isLikelyFilePath(value)) {
    return true;
  }

  if (isLikelyCodeOrCommand(value)) {
    return true;
  }

  if (isNumericOrSymbolHeavy(value)) {
    return true;
  }

  if (isStrongIdentifierLikeText(value) && !isLikelyUiTextContainer(parentElement)) {
    return true;
  }

  return false;
}

function isLikelyUrl(value) {
  return /^(?:https?:\/\/|ftp:\/\/|www\.)\S+$/iu.test(value) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/iu.test(value);
}

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isLikelyFilePath(value) {
  if (/\s/u.test(value)) {
    return false;
  }

  return /^(?:[A-Za-z]:\\|~?\/|\.{1,2}[\\/]).+/u.test(value) ||
    /^(?:[\w.-]+[\\/]){1,}[\w.-]+\.[A-Za-z0-9]{1,8}$/u.test(value) ||
    /^[\w.-]+\.(?:js|ts|jsx|tsx|json|html|css|md|txt|yml|yaml|xml|svg|png|jpg|jpeg|gif)$/iu.test(value);
}

function isLikelyCodeOrCommand(value) {
  if (/^`[^`]+`$/u.test(value)) {
    return true;
  }

  if (/^<\/?[a-z][^>]*>$/iu.test(value)) {
    return true;
  }

  if (/^(?:npm|pnpm|yarn|npx|bun|pip|python|node|git|docker|kubectl|curl)\s+\S+/iu.test(value)) {
    return true;
  }

  if (/^--[\w-]+(?:[= ]\S.*)?$/u.test(value)) {
    return true;
  }

  if (/^[A-Z][A-Z0-9_]*=\S+$/u.test(value)) {
    return true;
  }

  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\(?[^)]*\)?$/u.test(value)) {
    return true;
  }

  return /^[A-Za-z_$][\w$]*\([^)]*\)$/u.test(value);
}

function isStrongIdentifierLikeText(value) {
  if (value.length < 4 || /\s/u.test(value)) {
    return false;
  }

  return /^[a-z]+(?:[A-Z][a-z0-9]+)+$/u.test(value) ||
    /^[A-Z][A-Za-z0-9]+(?:[A-Z][a-z0-9]+)+$/u.test(value) ||
    /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/u.test(value);
}

function isNumericOrSymbolHeavy(value) {
  if (/[\p{L}]/u.test(value)) {
    return false;
  }

  return /^[\p{N}\p{P}\p{S}\s]+$/u.test(value);
}

function isLikelyUiTextContainer(element) {
  return Boolean(
    element.closest(
      "button, label, summary, option, [role='button'], [role='tab'], [role='menuitem'], [role='option']"
    )
  );
}

function inferSegmentType(targetNode, targetType) {
  const contextElement = getSegmentContextElement(targetNode, targetType);

  if (!contextElement) {
    return "paragraph";
  }

  if (contextElement.closest(
    "button, summary, [role='button'], [role='tab'], [role='menuitem'], input[type='button'], input[type='submit'], input[type='reset']"
  )) {
    return "button_like";
  }

  if (contextElement.closest("h1, h2, h3, h4, h5, h6")) {
    return "heading";
  }

  if (contextElement.closest("label, dt, th")) {
    return "label";
  }

  if (contextElement.closest("li")) {
    return "list_item";
  }

  if (contextElement.closest("a")) {
    return "link_text";
  }

  return "paragraph";
}

function getSegmentContextElement(targetNode, targetType) {
  if (targetType === "wrapper" && targetNode instanceof Element) {
    return targetNode.parentElement ?? targetNode;
  }

  if (targetNode instanceof Text) {
    return targetNode.parentElement;
  }

  if (targetNode instanceof Element) {
    return targetNode;
  }

  return null;
}

function splitText(value) {
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = value.match(/\s*$/)?.[0] ?? "";
  const startIndex = leadingWhitespace.length;
  const endIndex = value.length - trailingWhitespace.length;
  const core = value.slice(startIndex, endIndex);

  return {
    leadingWhitespace,
    trailingWhitespace,
    core: core.trim() ? core : ""
  };
}

function normalizeTranslatedText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}

function detectPageLanguage() {
  if (document.documentElement.lang) {
    return document.documentElement.lang;
  }

  return document.body?.getAttribute("lang") ?? "";
}

function getOrCreateTranslationSnapshot(snapshotId) {
  const currentSnapshot = pageState.translationSnapshot;

  if (currentSnapshot && currentSnapshot.id === snapshotId) {
    return currentSnapshot;
  }

  const nextSnapshot = buildTranslationSnapshot();
  pageState.translationSnapshot = nextSnapshot;

  return nextSnapshot;
}

function getActiveTranslationSnapshot(snapshotId) {
  const currentSnapshot = pageState.translationSnapshot;

  if (!currentSnapshot) {
    return null;
  }

  if (!snapshotId || currentSnapshot.id === snapshotId) {
    return currentSnapshot;
  }

  return null;
}

function buildTranslationSnapshot() {
  const snapshot = {
    id: `snapshot-${Date.now()}-${pageState.snapshotSequence + 1}`,
    nodesById: new Map(),
    segments: []
  };

  pageState.snapshotSequence += 1;
  collectSnapshotSegmentsFromNode(document.body, snapshot);

  return snapshot;
}

function getSnapshotBatch(snapshot, startIndex) {
  const batch = {
    segments: [],
    totalCharacters: 0,
    hasMore: false,
    nextIndex: startIndex
  };

  for (let index = startIndex; index < snapshot.segments.length; index += 1) {
    const segment = snapshot.segments[index];
    const isTextLimitReached =
      batch.segments.length >= MAX_SEGMENTS ||
      batch.totalCharacters + segment.text.length > MAX_TOTAL_CHARACTERS;

    if (isTextLimitReached) {
      batch.hasMore = true;
      batch.nextIndex = index;
      return batch;
    }

    batch.segments.push({
      id: segment.id,
      text: segment.text,
      type: segment.type
    });
    batch.totalCharacters += segment.text.length;
    batch.nextIndex = index + 1;
  }

  return batch;
}

function collectSnapshotSegmentsFromNode(node, snapshot) {
  if (!node) {
    return;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node;

    if (isOurTranslatedElement(element)) {
      appendSnapshotNode(
        element,
        "wrapper",
        element.dataset.originalFull ?? element.textContent ?? "",
        snapshot
      );
      return;
    }

    if (isExcludedElement(element) || !isVisible(element)) {
      return;
    }

    for (const childNode of element.childNodes) {
      collectSnapshotSegmentsFromNode(childNode, snapshot);
    }

    return;
  }

  if (node.nodeType === Node.TEXT_NODE && !shouldSkipTextNode(node)) {
    appendSnapshotNode(node, "text", node.nodeValue ?? "", snapshot);
  }
}

function appendSnapshotNode(targetNode, targetType, originalFull, snapshot) {
  const parts = splitText(originalFull);

  if (!parts.core) {
    return;
  }

  const id = `segment-${snapshot.segments.length + 1}`;
  const segmentType = inferSegmentType(targetNode, targetType);

  snapshot.nodesById.set(id, {
    targetNode,
    targetType,
    segmentType,
    originalFull,
    originalCore: parts.core,
    leadingWhitespace: parts.leadingWhitespace,
    trailingWhitespace: parts.trailingWhitespace
  });

  snapshot.segments.push({
    id,
    text: parts.core,
    type: segmentType
  });
}

function isOurTranslatedElement(element) {
  return (
    element instanceof Element &&
    element.getAttribute(TRANSLATED_MARKER_ATTRIBUTE) === TRANSLATED_MARKER_VALUE
  );
}

function isAutoTranslateSafe() {
  return !hasSensitivePageSignals();
}

function hasSensitivePageSignals() {
  const hostname = window.location.hostname.toLowerCase();
  const sensitiveHosts = [
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "mail.yahoo.com",
    "mail.naver.com",
    "mail.daum.net",
    "mail.proton.me",
    "app.slack.com",
    "discord.com",
    "teams.microsoft.com",
    "docs.google.com",
    "drive.google.com",
    "calendar.google.com"
  ];

  if (sensitiveHosts.some((host) => hostname === host)) {
    return true;
  }

  return Boolean(document.querySelector("input[type='password']"));
}

function initializeAutoTranslateHooks() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function pushStateWrapper(...args) {
    const result = originalPushState.apply(this, args);
    scheduleAutoTranslateCheck();
    return result;
  };

  history.replaceState = function replaceStateWrapper(...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleAutoTranslateCheck();
    return result;
  };

  window.addEventListener("popstate", scheduleAutoTranslateCheck);
  window.addEventListener("pageshow", scheduleAutoTranslateCheck);
}

function scheduleAutoTranslateCheck() {
  window.clearTimeout(pageState.autoTranslateTimer);
  pageState.autoTranslateTimer = window.setTimeout(() => {
    void chrome.runtime.sendMessage({
      type: "PAGE_READY",
      pageLanguage: detectPageLanguage(),
      autoTranslateSafe: isAutoTranslateSafe(),
      url: window.location.href
    });
  }, AUTO_TRANSLATE_READY_DELAY_MS);
}
