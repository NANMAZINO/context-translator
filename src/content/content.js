const TRANSLATED_CLASS_NAME = "context-translator__translated-text";
const TRANSLATED_MARKER_ATTRIBUTE = "data-context-translator";
const TRANSLATED_MARKER_VALUE = "translated";
const MAX_SEGMENTS = 180;
const MAX_TOTAL_CHARACTERS = 18000;
const AUTO_TRANSLATE_READY_DELAY_MS = 800;
const INLINE_CONTEXT_WINDOW_CHARACTERS = 260;
const EXCLUDED_TAG_NAMES = new Set([
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
const CONTEXT_GROUP_BOUNDARY_SELECTOR = [
  "a",
  "article",
  "aside",
  "blockquote",
  "button",
  "dd",
  "details",
  "dialog",
  "div",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "section",
  "summary",
  "td",
  "th",
  "ul",
  "[role='button']",
  "[role='heading']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']"
].join(", ");

const pageState = {
  autoTranslateTimer: null,
  lastObservedUrl: window.location.href,
  snapshotSequence: 0,
  translationSnapshot: null,
  directTranslationEntries: new Set(),
  directTranslationByNode: new WeakMap()
};

function t(messageName, substitutions, fallback = "") {
  return chrome.i18n.getMessage(messageName, substitutions) || fallback || messageName;
}

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
          error: error instanceof Error ? error.message : t("couldNotReadPageText")
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
      error: t("pageBodyMissing")
    };
  }

  const startIndex = Number.isInteger(options.startIndex) && options.startIndex > 0
    ? options.startIndex
    : 0;
  const expectedPageUrl = String(options.expectedPageUrl ?? "");

  if (expectedPageUrl && expectedPageUrl !== window.location.href) {
    return {
      ok: false,
      error: t("pageChangedTranslationStopped")
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
      error: t("pageChangedCannotApply")
    };
  }

  const snapshot = getActiveTranslationSnapshot(String(options.snapshotId ?? ""));

  if (!snapshot) {
    return {
      ok: false,
      error: t("pageStateChangedNeedsRetranslate")
    };
  }

  const safeTranslations = Array.isArray(translations) ? translations : [];
  let appliedCount = 0;
  let skippedCount = 0;
  cleanupDirectTranslationEntries();

  for (const item of safeTranslations) {
    const collected = snapshot.nodesById.get(item.id);

    if (!collected || !collected.targetNode?.isConnected) {
      skippedCount += 1;
      continue;
    }

    const translatedText = normalizeTranslatedText(item.translatedText, collected.originalCore);
    const renderedText =
      collected.leadingWhitespace + translatedText + collected.trailingWhitespace;

    if (shouldApplyDirectTextTranslation(collected, showOriginalOnHover)) {
      applyDirectTextTranslation(collected, renderedText);
      appliedCount += 1;
      continue;
    }

    applyWrappedTranslation(collected, renderedText, showOriginalOnHover);
    appliedCount += 1;
  }

  return {
    ok: true,
    appliedCount,
    skippedCount,
    retryRecommended: skippedCount > 0
  };
}

function updateHoverMode(enabled) {
  cleanupDirectTranslationEntries();

  if (enabled) {
    for (const entry of Array.from(pageState.directTranslationEntries)) {
      upgradeDirectTranslationEntryToWrapper(entry);
    }
  }

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

function shouldApplyDirectTextTranslation(collected, showOriginalOnHover) {
  return (
    !showOriginalOnHover &&
    collected.targetType === "text" &&
    collected.targetNode instanceof Text
  );
}

function applyDirectTextTranslation(collected, renderedText) {
  const targetNode = collected.targetNode;

  if (!(targetNode instanceof Text)) {
    return;
  }

  forgetDirectTranslation(targetNode);
  targetNode.nodeValue = renderedText;
  trackDirectTranslation({
    node: targetNode,
    originalFull: collected.originalFull,
    originalCore: collected.originalCore
  });
}

function applyWrappedTranslation(collected, renderedText, showOriginalOnHover) {
  const wrapper =
    collected.targetType === "wrapper" && isOurTranslatedElement(collected.targetNode)
      ? collected.targetNode
      : createTranslatedWrapper(
        collected.originalFull,
        collected.originalCore,
        renderedText,
        showOriginalOnHover
      );

  if (wrapper !== collected.targetNode) {
    wrapper.className = TRANSLATED_CLASS_NAME;
    wrapper.setAttribute(TRANSLATED_MARKER_ATTRIBUTE, TRANSLATED_MARKER_VALUE);
  }

  wrapper.dataset.originalFull = collected.originalFull;
  wrapper.dataset.originalCore = collected.originalCore;
  wrapper.textContent = renderedText;

  if (showOriginalOnHover) {
    wrapper.title = collected.originalCore;
  } else {
    wrapper.removeAttribute("title");
  }

  if (collected.targetType === "wrapper") {
    return;
  }

  if (collected.targetNode instanceof Text) {
    forgetDirectTranslation(collected.targetNode);
  }

  collected.targetNode.replaceWith(wrapper);
}

function createTranslatedWrapper(originalFull, originalCore, renderedText, showOriginalOnHover) {
  const wrapper = document.createElement("span");
  wrapper.className = TRANSLATED_CLASS_NAME;
  wrapper.setAttribute(TRANSLATED_MARKER_ATTRIBUTE, TRANSLATED_MARKER_VALUE);
  wrapper.dataset.originalFull = originalFull;
  wrapper.dataset.originalCore = originalCore;
  wrapper.textContent = renderedText;

  if (showOriginalOnHover) {
    wrapper.title = originalCore;
  }

  return wrapper;
}

function trackDirectTranslation(entry) {
  const existingEntry = pageState.directTranslationByNode.get(entry.node);

  if (existingEntry) {
    pageState.directTranslationEntries.delete(existingEntry);
  }

  pageState.directTranslationByNode.set(entry.node, entry);
  pageState.directTranslationEntries.add(entry);
}

function forgetDirectTranslation(textNode) {
  if (!(textNode instanceof Text)) {
    return;
  }

  const existingEntry = pageState.directTranslationByNode.get(textNode);

  if (!existingEntry) {
    return;
  }

  pageState.directTranslationEntries.delete(existingEntry);
  pageState.directTranslationByNode.delete(textNode);
}

function cleanupDirectTranslationEntries() {
  for (const entry of Array.from(pageState.directTranslationEntries)) {
    if (!entry.node?.isConnected) {
      pageState.directTranslationEntries.delete(entry);

      if (entry.node instanceof Text) {
        pageState.directTranslationByNode.delete(entry.node);
      }
    }
  }
}

function upgradeDirectTranslationEntryToWrapper(entry) {
  if (!(entry?.node instanceof Text) || !entry.node.isConnected) {
    pageState.directTranslationEntries.delete(entry);

    if (entry?.node instanceof Text) {
      pageState.directTranslationByNode.delete(entry.node);
    }

    return;
  }

  const wrapper = createTranslatedWrapper(
    entry.originalFull,
    entry.originalCore,
    entry.node.nodeValue ?? entry.originalFull,
    true
  );

  entry.node.replaceWith(wrapper);
  forgetDirectTranslation(entry.node);
}

function shouldSkipTextNode(textNode, traversalState) {
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

  const value = getSourceTextForTextNode(textNode);
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return true;
  }

  if (!containsTranslatableText(normalizedValue)) {
    return true;
  }

  if (shouldPreserveSourceText(normalizedValue, parent)) {
    return true;
  }

  return !isVisible(parent, traversalState?.visibilityByElement);
}

function isExcludedElement(element) {
  if (EXCLUDED_TAG_NAMES.has(element.tagName)) {
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

function isVisible(element, visibilityByElement) {
  if (visibilityByElement?.has(element)) {
    return visibilityByElement.get(element);
  }

  if (element.closest("[aria-hidden='true']")) {
    visibilityByElement?.set(element, false);
    return false;
  }

  const style = window.getComputedStyle(element);
  const isVisibleElement = !(
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) && element.getClientRects().length > 0;

  visibilityByElement?.set(element, isVisibleElement);
  return isVisibleElement;
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

function getContextGroupElement(targetNode, targetType) {
  const contextElement = getSegmentContextElement(targetNode, targetType);

  if (!contextElement) {
    return null;
  }

  return contextElement.closest(CONTEXT_GROUP_BOUNDARY_SELECTOR) ?? contextElement;
}

function getSourceTextForTextNode(textNode) {
  if (!(textNode instanceof Text)) {
    return "";
  }

  return pageState.directTranslationByNode.get(textNode)?.originalFull ?? textNode.nodeValue ?? "";
}

function attachInlineContextToSegments(snapshot) {
  const groupedSegments = new Map();

  for (const segment of snapshot.segments) {
    const contextGroupElement = snapshot.nodesById.get(segment.id)?.contextGroupElement ?? null;
    const groupKey = contextGroupElement ?? snapshot;

    if (!groupedSegments.has(groupKey)) {
      groupedSegments.set(groupKey, []);
    }

    groupedSegments.get(groupKey).push(segment);
  }

  for (const groupSegments of groupedSegments.values()) {
    let combinedText = "";
    const positions = [];

    for (const segment of groupSegments) {
      if (combinedText) {
        combinedText += " ";
      }

      const start = combinedText.length;
      combinedText += segment.text;
      positions.push({
        segment,
        start,
        end: combinedText.length
      });
    }

    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      position.segment.contextText = buildInlineContextSnippet(
        combinedText,
        position.start,
        position.end
      );
      position.segment.contextIndex = index;
      position.segment.contextCount = positions.length;
    }
  }
}

function buildInlineContextSnippet(text, startIndex, endIndex) {
  if (text.length <= INLINE_CONTEXT_WINDOW_CHARACTERS) {
    return text;
  }

  const focusLength = endIndex - startIndex;
  const remainingLength = Math.max(0, INLINE_CONTEXT_WINDOW_CHARACTERS - focusLength);
  const halfWindow = Math.floor(remainingLength / 2);
  let sliceStart = Math.max(0, startIndex - halfWindow);
  let sliceEnd = Math.min(text.length, endIndex + (remainingLength - halfWindow));

  if (sliceEnd - sliceStart > INLINE_CONTEXT_WINDOW_CHARACTERS) {
    sliceEnd = sliceStart + INLINE_CONTEXT_WINDOW_CHARACTERS;
  }

  if (sliceEnd === text.length && sliceEnd - sliceStart < INLINE_CONTEXT_WINDOW_CHARACTERS) {
    sliceStart = Math.max(0, sliceEnd - INLINE_CONTEXT_WINDOW_CHARACTERS);
  }

  const prefix = sliceStart > 0 ? "..." : "";
  const suffix = sliceEnd < text.length ? "..." : "";
  return `${prefix}${text.slice(sliceStart, sliceEnd).trim()}${suffix}`;
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
  const traversalState = {
    visibilityByElement: new WeakMap()
  };

  cleanupDirectTranslationEntries();
  pageState.snapshotSequence += 1;
  collectSnapshotSegmentsFromNode(document.body, snapshot, traversalState);
  attachInlineContextToSegments(snapshot);

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

function collectSnapshotSegmentsFromNode(node, snapshot, traversalState) {
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

    if (isExcludedElement(element) || !isVisible(element, traversalState?.visibilityByElement)) {
      return;
    }

    for (const childNode of element.childNodes) {
      collectSnapshotSegmentsFromNode(childNode, snapshot, traversalState);
    }

    return;
  }

  if (node.nodeType === Node.TEXT_NODE && !shouldSkipTextNode(node, traversalState)) {
    appendSnapshotNode(node, "text", getSourceTextForTextNode(node), snapshot);
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
    contextGroupElement: getContextGroupElement(targetNode, targetType),
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
    scheduleAutoTranslateCheck({ forceNavigation: true });
    return result;
  };

  history.replaceState = function replaceStateWrapper(...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleAutoTranslateCheck({ forceNavigation: true });
    return result;
  };

  window.addEventListener("popstate", () => {
    scheduleAutoTranslateCheck({ forceNavigation: true });
  });
  window.addEventListener("pageshow", () => {
    scheduleAutoTranslateCheck({ forceNavigation: true });
  });
}

function scheduleAutoTranslateCheck(options = {}) {
  const {
    forceNavigation = false
  } = options;
  const currentUrl = window.location.href;
  const urlChanged = pageState.lastObservedUrl !== currentUrl;

  if (urlChanged) {
    pageState.lastObservedUrl = currentUrl;
    pageState.translationSnapshot = null;

    void chrome.runtime.sendMessage({
      type: "PAGE_NAVIGATION",
      url: currentUrl,
      force: forceNavigation
    }).catch(() => {
      // Ignore navigation notification failures.
    });
  }

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
