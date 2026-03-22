import {
  LANGUAGE_CODES,
  createDefaultSettings,
  getLanguageLabel,
  getMessageLocale,
  getUiLanguageTag,
  normalizeLanguageCode,
  t
} from "../shared/i18n.js";

const DEFAULT_SETTINGS = createDefaultSettings();
const API_STATUS_CACHE_STORAGE_KEY = "apiStatusCache";

const state = {
  activeTab: null,
  currentPageUrl: "",
  currentHost: "",
  isSupportedPage: false,
  pageLanguageHint: "",
  settings: { ...DEFAULT_SETTINGS },
  apiStatus: createDefaultApiStatus()
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  void initializePopup();
});

function createDefaultApiStatus() {
  return {
    message: t("apiStatusMissingKey"),
    tone: "normal",
    checking: false,
    requestId: 0,
    checkedAtLabel: ""
  };
}

async function initializePopup() {
  cacheElements();
  applyStaticTranslations();
  bindRuntimeEvents();
  populateLanguageOptions();
  bindEvents();
  await loadState();
}

function cacheElements() {
  elements.sourceLanguageSrLabel = document.getElementById("sourceLanguageSrLabel");
  elements.sourceLanguage = document.getElementById("sourceLanguage");
  elements.targetLanguageSrLabel = document.getElementById("targetLanguageSrLabel");
  elements.targetLanguage = document.getElementById("targetLanguage");
  elements.swapLanguages = document.getElementById("swapLanguages");
  elements.alwaysTranslateLanguage = document.getElementById("alwaysTranslateLanguage");
  elements.alwaysTranslateLanguageLabel = document.getElementById("alwaysTranslateLanguageLabel");
  elements.alwaysTranslateSite = document.getElementById("alwaysTranslateSite");
  elements.alwaysTranslateSiteLabel = document.getElementById("alwaysTranslateSiteLabel");
  elements.showOriginalOnHover = document.getElementById("showOriginalOnHover");
  elements.showOriginalOnHoverLabel = document.getElementById("showOriginalOnHoverLabel");
  elements.siteHint = document.getElementById("siteHint");
  elements.apiKeyLabel = document.getElementById("apiKeyLabel");
  elements.apiKey = document.getElementById("apiKey");
  elements.saveApiKey = document.getElementById("saveApiKey");
  elements.clearApiKey = document.getElementById("clearApiKey");
  elements.apiServerStatusLabel = document.getElementById("apiServerStatusLabel");
  elements.apiServerStatus = document.getElementById("apiServerStatus");
  elements.checkApiStatus = document.getElementById("checkApiStatus");
  elements.statusMessage = document.getElementById("statusMessage");
  elements.translateButton = document.getElementById("translateButton");
}

function applyStaticTranslations() {
  document.documentElement.lang = getUiLanguageTag();
  document.title = t("extensionName") || "Context Translator";

  elements.sourceLanguageSrLabel.textContent = t("sourceLanguageLabel");
  elements.targetLanguageSrLabel.textContent = t("targetLanguageLabel");
  elements.sourceLanguage.setAttribute("aria-label", t("sourceLanguageLabel"));
  elements.targetLanguage.setAttribute("aria-label", t("targetLanguageLabel"));
  elements.swapLanguages.setAttribute("aria-label", t("swapLanguagesAriaLabel"));
  elements.alwaysTranslateSiteLabel.textContent = t("alwaysTranslateSiteLabel");
  elements.showOriginalOnHoverLabel.textContent = t("showOriginalOnHoverLabel");
  elements.apiKeyLabel.textContent = t("apiKeyLabel");
  elements.saveApiKey.textContent = t("saveButton");
  elements.clearApiKey.textContent = t("clearButton");
  elements.apiServerStatusLabel.textContent = t("apiServerStatusLabel");
  elements.checkApiStatus.textContent = t("apiStatusCheckButton");
  elements.translateButton.textContent = t("translateButton");
}

function bindRuntimeEvents() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "TRANSLATION_PROGRESS") {
      return false;
    }

    if (
      !state.activeTab?.id ||
      message.tabId !== state.activeTab.id ||
      !matchesCurrentPageUrl(message.pageUrl)
    ) {
      return false;
    }

    updateTranslationProgressStatus(message);
    return false;
  });
}

function populateLanguageOptions() {
  elements.sourceLanguage.innerHTML = LANGUAGE_CODES
    .map((code) => `<option value="${code}">${getLanguageLabel(code)}</option>`)
    .join("");

  elements.targetLanguage.innerHTML = LANGUAGE_CODES
    .filter((code) => code !== "auto")
    .map((code) => `<option value="${code}">${getLanguageLabel(code)}</option>`)
    .join("");
}

function bindEvents() {
  elements.sourceLanguage.addEventListener("change", handleSourceLanguageChange);
  elements.targetLanguage.addEventListener("change", handleTargetLanguageChange);
  elements.swapLanguages.addEventListener("click", handleSwapLanguages);
  elements.alwaysTranslateLanguage.addEventListener("change", handleAlwaysTranslateLanguageChange);
  elements.alwaysTranslateSite.addEventListener("change", handleAlwaysTranslateSiteChange);
  elements.showOriginalOnHover.addEventListener("change", handleShowOriginalChange);
  elements.saveApiKey.addEventListener("click", () => void saveApiKey());
  elements.clearApiKey.addEventListener("click", () => void clearApiKey());
  elements.checkApiStatus.addEventListener("click", () => void refreshApiServerStatus());
  elements.apiKey.addEventListener("input", handleApiKeyInput);
  elements.apiKey.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveApiKey();
    }
  });
  elements.translateButton.addEventListener("click", () => void handleTranslate());
}

async function loadState() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab = activeTab ?? null;
  state.currentPageUrl = activeTab?.url ?? "";

  const tabInfo = getTabInfo(activeTab?.url ?? "");
  state.currentHost = tabInfo.host;
  state.isSupportedPage = tabInfo.isSupportedPage;
  state.pageLanguageHint = await detectPageLanguageHint();

  const storedValues = await chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    [API_STATUS_CACHE_STORAGE_KEY]: null
  });
  const storedSettings = {
    ...storedValues
  };
  const storedApiStatusCache = storedSettings[API_STATUS_CACHE_STORAGE_KEY];
  delete storedSettings[API_STATUS_CACHE_STORAGE_KEY];

  state.settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    autoTranslateLanguages: Array.isArray(storedSettings.autoTranslateLanguages)
      ? storedSettings.autoTranslateLanguages.filter((language) => language !== "auto")
      : [],
    alwaysTranslateSites: Array.isArray(storedSettings.alwaysTranslateSites)
      ? storedSettings.alwaysTranslateSites
      : []
  };

  if (state.settings.targetLanguage === "auto") {
    state.settings.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
    await chrome.storage.local.set({ targetLanguage: DEFAULT_SETTINGS.targetLanguage });
  }

  restoreApiServerStatus(state.settings.apiKey, storedApiStatusCache);
  renderState();
  await loadTranslationStatus();
}

async function loadTranslationStatus() {
  if (!state.activeTab?.id) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_TRANSLATION_STATUS",
      tabId: state.activeTab.id
    });

    if (!response?.ok || !response.status || !matchesCurrentPageUrl(response.status.pageUrl)) {
      return;
    }

    updateTranslationProgressStatus(response.status);
  } catch (error) {
    // Ignore restore failure.
  }
}

function renderState() {
  elements.sourceLanguage.value = state.settings.sourceLanguage;
  elements.targetLanguage.value = state.settings.targetLanguage;
  elements.showOriginalOnHover.checked = state.settings.showOriginalOnHover;
  elements.apiKey.value = state.settings.apiKey;

  updateAlwaysTranslateLanguageLabel();
  syncLanguageAutoTranslateCheckbox();
  syncSiteAutoTranslateCheckbox();
  updateSwapButtonState();
  renderSiteHint();
  renderApiServerStatus();
  refreshTranslateButtonState();
}

function renderApiServerStatus() {
  const toneClass = state.apiStatus.tone === "normal" ? "" : ` ${state.apiStatus.tone}`;
  const checkedAtSuffix = state.apiStatus.checkedAtLabel
    ? ` (${state.apiStatus.checkedAtLabel})`
    : "";
  elements.apiServerStatus.textContent = `${state.apiStatus.message}${checkedAtSuffix}`;
  elements.apiServerStatus.className = `api-server-status__value${toneClass}`;
  elements.checkApiStatus.disabled = state.apiStatus.checking;
  elements.checkApiStatus.textContent = state.apiStatus.checking
    ? t("apiStatusCheckingButton")
    : t("apiStatusCheckButton");
}

function setApiServerStatus(message, tone = "normal", checkedAtLabel = "") {
  state.apiStatus.message = message;
  state.apiStatus.tone = tone;
  state.apiStatus.checkedAtLabel = checkedAtLabel;
  renderApiServerStatus();
}

function resetApiServerStatus(apiKey = state.settings.apiKey) {
  state.apiStatus.message = apiKey
    ? t("apiStatusStoredKeyPrompt")
    : t("apiStatusMissingKey");
  state.apiStatus.tone = "normal";
  state.apiStatus.checking = false;
  state.apiStatus.checkedAtLabel = "";
}

function restoreApiServerStatus(apiKey, cache) {
  if (!apiKey) {
    resetApiServerStatus("");
    return;
  }

  if (!isStoredApiStatus(cache) || cache.uiLocale !== getMessageLocale()) {
    resetApiServerStatus(apiKey);
    return;
  }

  state.apiStatus.message = cache.message;
  state.apiStatus.tone = cache.tone;
  state.apiStatus.checking = false;
  state.apiStatus.checkedAtLabel = cache.checkedAt
    ? formatCheckedAt(cache.checkedAt)
    : "";
}

function handleApiKeyInput() {
  refreshTranslateButtonState();

  const apiKey = elements.apiKey.value.trim();

  if (!apiKey) {
    setApiServerStatus(t("apiStatusMissingKey"), "normal");
    return;
  }

  if (apiKey !== state.settings.apiKey) {
    setApiServerStatus(t("apiStatusChangedKeyPrompt"), "normal");
    return;
  }

  if (!state.apiStatus.checkedAtLabel && state.apiStatus.tone === "normal") {
    resetApiServerStatus(apiKey);
    renderApiServerStatus();
  }
}

function updateAlwaysTranslateLanguageLabel() {
  if (elements.sourceLanguage.value === "auto") {
    const detectedLabel = getLanguageLabel(state.pageLanguageHint);
    elements.alwaysTranslateLanguageLabel.textContent = detectedLabel
      ? t("alwaysTranslateLanguageLabelNamed", [detectedLabel])
      : t("alwaysTranslateLanguageLabelDetected");
    return;
  }

  const sourceLabel = getLanguageLabel(elements.sourceLanguage.value);
  elements.alwaysTranslateLanguageLabel.textContent = t("alwaysTranslateLanguageLabelNamed", [
    sourceLabel
  ]);
}

function syncLanguageAutoTranslateCheckbox() {
  const effectiveSourceLanguage = getEffectiveSourceLanguage();
  const canConfigureLanguageRule = Boolean(effectiveSourceLanguage);

  elements.alwaysTranslateLanguage.disabled = !canConfigureLanguageRule;
  elements.alwaysTranslateLanguage.checked = canConfigureLanguageRule
    ? matchesStoredLanguageCode(state.settings.autoTranslateLanguages, effectiveSourceLanguage)
    : false;
}

function syncSiteAutoTranslateCheckbox() {
  const isChecked = state.currentHost
    ? state.settings.alwaysTranslateSites.includes(state.currentHost)
    : false;

  elements.alwaysTranslateSite.checked = isChecked;
  elements.alwaysTranslateSite.disabled = !state.isSupportedPage || !state.currentHost;
}

function renderSiteHint() {
  if (!state.isSupportedPage || !state.currentHost) {
    elements.siteHint.textContent = t("siteHintUnsupported");
    return;
  }

  if (elements.sourceLanguage.value === "auto" && state.pageLanguageHint) {
    elements.siteHint.textContent = t("siteHintCurrentSiteWithLanguage", [
      state.currentHost,
      getLanguageLabel(state.pageLanguageHint)
    ]);
    return;
  }

  elements.siteHint.textContent = t("siteHintCurrentSite", [state.currentHost]);
}

function updateSwapButtonState() {
  elements.swapLanguages.disabled = elements.sourceLanguage.value === "auto";
}

function refreshTranslateButtonState() {
  const sourceLanguage = elements.sourceLanguage.value;
  const targetLanguage = elements.targetLanguage.value;
  const hasApiKey = Boolean(elements.apiKey.value.trim());

  elements.translateButton.disabled =
    !state.isSupportedPage || !hasApiKey || sourceLanguage === targetLanguage;

  if (!state.isSupportedPage) {
    setStatus(t("unsupportedPage"), "error");
    return;
  }

  if (sourceLanguage === targetLanguage) {
    setStatus(t("sameLanguageError"), "error");
    return;
  }

  if (!hasApiKey) {
    setStatus(t("missingApiKeyPrompt"), "normal");
    return;
  }

  clearStatus();
}

async function handleSourceLanguageChange() {
  await saveSettings({ sourceLanguage: elements.sourceLanguage.value });
  updateAlwaysTranslateLanguageLabel();
  syncLanguageAutoTranslateCheckbox();
  updateSwapButtonState();
  renderSiteHint();
  refreshTranslateButtonState();
}

async function handleTargetLanguageChange() {
  await saveSettings({ targetLanguage: elements.targetLanguage.value });
  refreshTranslateButtonState();
}

async function handleSwapLanguages() {
  if (elements.sourceLanguage.value === "auto") {
    setStatus(t("swapAutoSourceError"), "error");
    return;
  }

  const nextSource = elements.targetLanguage.value;
  const nextTarget = elements.sourceLanguage.value;

  elements.sourceLanguage.value = nextSource;
  elements.targetLanguage.value = nextTarget;

  await saveSettings({
    sourceLanguage: nextSource,
    targetLanguage: nextTarget
  });

  updateAlwaysTranslateLanguageLabel();
  syncLanguageAutoTranslateCheckbox();
  refreshTranslateButtonState();
}

async function handleAlwaysTranslateLanguageChange() {
  const languages = new Set(state.settings.autoTranslateLanguages);
  const selectedSourceLanguage = getEffectiveSourceLanguage();

  if (!selectedSourceLanguage) {
    elements.alwaysTranslateLanguage.checked = false;
    setStatus(t("languageDetectionUnavailableError"), "error");
    return;
  }

  if (elements.alwaysTranslateLanguage.checked) {
    languages.add(selectedSourceLanguage);
  } else {
    languages.delete(selectedSourceLanguage);
  }

  await saveSettings({ autoTranslateLanguages: Array.from(languages) });
}

async function handleAlwaysTranslateSiteChange() {
  if (!state.currentHost) {
    elements.alwaysTranslateSite.checked = false;
    return;
  }

  const sites = new Set(state.settings.alwaysTranslateSites);

  if (elements.alwaysTranslateSite.checked) {
    sites.add(state.currentHost);
  } else {
    sites.delete(state.currentHost);
  }

  await saveSettings({ alwaysTranslateSites: Array.from(sites) });
}

async function handleShowOriginalChange() {
  const enabled = elements.showOriginalOnHover.checked;
  await saveSettings({ showOriginalOnHover: enabled });

  if (state.isSupportedPage && state.activeTab?.id) {
    try {
      await chrome.tabs.sendMessage(state.activeTab.id, {
        type: "UPDATE_HOVER_MODE",
        enabled
      });
    } catch (error) {
      // There may be no translated nodes yet.
    }
  }
}

async function saveApiKey() {
  const apiKey = elements.apiKey.value.trim();
  await saveSettings({ apiKey });
  refreshTranslateButtonState();

  if (apiKey) {
    setStatus(t("apiKeySaved"), "success");
  } else {
    setStatus(t("apiKeyCleared"), "success");
  }

  await refreshApiServerStatus({ apiKey });
}

async function clearApiKey() {
  elements.apiKey.value = "";
  await saveSettings({ apiKey: "" });
  refreshTranslateButtonState();
  setStatus(t("apiKeyCleared"), "success");
  setApiServerStatus(t("apiStatusMissingKey"), "normal");
}

async function refreshApiServerStatus(options = {}) {
  const { apiKey = elements.apiKey.value.trim(), quietOnEmpty = false } = options;

  if (!apiKey) {
    if (!quietOnEmpty) {
      setApiServerStatus(t("apiStatusMissingKey"), "normal");
    }
    return;
  }

  const requestId = state.apiStatus.requestId + 1;
  state.apiStatus.requestId = requestId;
  state.apiStatus.checking = true;
  renderApiServerStatus();
  setApiServerStatus(t("apiStatusChecking"), "normal");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_API_STATUS",
      apiKey
    });

    if (requestId !== state.apiStatus.requestId || apiKey !== elements.apiKey.value.trim()) {
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error ?? t("translationCouldNotComplete"));
    }

    const checkedAt = Date.now();
    const latency = typeof response.latencyMs === "number"
      ? t("apiStatusLatency", [String(response.latencyMs)])
      : "";
    const successMessage = t("apiStatusConnected", [response.modelName, latency]);

    setApiServerStatus(
      successMessage,
      "success",
      formatCheckedAt(checkedAt)
    );
    await persistApiServerStatus({
      message: successMessage,
      tone: "success",
      checkedAt,
      uiLocale: getMessageLocale()
    });
  } catch (error) {
    if (requestId !== state.apiStatus.requestId || apiKey !== elements.apiKey.value.trim()) {
      return;
    }

    const checkedAt = Date.now();
    const errorMessage = error.message || t("translationCouldNotComplete");
    setApiServerStatus(
      errorMessage,
      "error",
      formatCheckedAt(checkedAt)
    );
    await persistApiServerStatus({
      message: errorMessage,
      tone: "error",
      checkedAt,
      uiLocale: getMessageLocale()
    });
  } finally {
    if (requestId === state.apiStatus.requestId) {
      state.apiStatus.checking = false;
      renderApiServerStatus();
    }
  }
}

function updateTranslationProgressStatus(message) {
  const stage = message?.stage || message?.state;

  if (!stage || !matchesCurrentPageUrl(message?.pageUrl)) {
    return;
  }

  if (stage === "queued") {
    setStatus(t("translationQueued"), "normal");
    return;
  }

  if (stage === "translating") {
    setStatus(t("translationBatchInProgress", [String(message.batchCount)]), "normal");
    return;
  }

  if (stage === "continuing") {
    setStatus(t("translationContinuing", [String(message.batchCount)]), "normal");
    return;
  }

  if (stage === "failed" || stage === "error") {
    setStatus(getFailedTranslationMessage(message), "error");
    return;
  }

  if (stage === "complete") {
    if ((message.batchCount ?? 1) > 1) {
      setStatus(t("translationCompletedMultiBatch", [String(message.batchCount)]), "success");
      return;
    }

    setStatus(t("translationCompleted"), "success");
  }
}

function matchesCurrentPageUrl(pageUrl) {
  if (!pageUrl || !state.currentPageUrl) {
    return true;
  }

  return pageUrl === state.currentPageUrl;
}

function getFailedTranslationMessage(message) {
  return (
    message?.error ||
    message?.errorMessage ||
    message?.message ||
    t("failedTranslationGeneric")
  );
}

async function handleTranslate() {
  if (!state.activeTab?.id) {
    setStatus(t("currentTabMissing"), "error");
    return;
  }

  await saveSettings({
    sourceLanguage: elements.sourceLanguage.value,
    targetLanguage: elements.targetLanguage.value,
    showOriginalOnHover: elements.showOriginalOnHover.checked,
    apiKey: elements.apiKey.value.trim()
  });

  refreshTranslateButtonState();

  if (elements.translateButton.disabled) {
    return;
  }

  setStatus(t("translateStarting"), "normal");
  elements.translateButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_TRANSLATION",
      tabId: state.activeTab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? t("translationCouldNotComplete"));
    }

    updateTranslationProgressStatus({
      stage: "complete",
      batchCount: response.batchCount ?? 1
    });
  } catch (error) {
    setStatus(error.message || t("translationCouldNotComplete"), "error");
  } finally {
    elements.translateButton.disabled =
      !state.isSupportedPage ||
      !Boolean(elements.apiKey.value.trim()) ||
      elements.sourceLanguage.value === elements.targetLanguage.value;
  }
}

async function saveSettings(patch) {
  const previousApiKey = state.settings.apiKey;
  const hasApiKeyPatch = Object.prototype.hasOwnProperty.call(patch, "apiKey");
  const apiKeyChanged = hasApiKeyPatch && patch.apiKey !== previousApiKey;

  state.settings = {
    ...state.settings,
    ...patch
  };

  await chrome.storage.local.set(patch);

  if (apiKeyChanged) {
    await clearStoredApiServerStatus();
  }
}

async function persistApiServerStatus(cache) {
  if (!isStoredApiStatus(cache)) {
    return;
  }

  await chrome.storage.local.set({
    [API_STATUS_CACHE_STORAGE_KEY]: cache
  });
}

async function clearStoredApiServerStatus() {
  await chrome.storage.local.remove(API_STATUS_CACHE_STORAGE_KEY);
}

function isStoredApiStatus(cache) {
  return (
    typeof cache?.message === "string" &&
    (cache?.tone === "normal" || cache?.tone === "success" || cache?.tone === "error") &&
    typeof cache?.checkedAt === "number" &&
    cache.checkedAt > 0 &&
    typeof cache?.uiLocale === "string" &&
    cache.uiLocale.length > 0
  );
}

function getTabInfo(urlString) {
  try {
    const url = new URL(urlString);
    const isSupportedPage = url.protocol === "http:" || url.protocol === "https:";

    return {
      host: isSupportedPage ? url.hostname : "",
      isSupportedPage
    };
  } catch (error) {
    return {
      host: "",
      isSupportedPage: false
    };
  }
}

async function detectPageLanguageHint() {
  if (!state.isSupportedPage || !state.activeTab?.id) {
    return "";
  }

  try {
    const detectedLanguage = await chrome.tabs.detectLanguage(state.activeTab.id);
    return detectedLanguage && detectedLanguage !== "und" ? detectedLanguage : "";
  } catch (error) {
    return "";
  }
}

function getEffectiveSourceLanguage() {
  if (elements.sourceLanguage.value !== "auto") {
    return elements.sourceLanguage.value;
  }

  return state.pageLanguageHint || "";
}

function matchesStoredLanguageCode(storedLanguages, targetLanguage) {
  const normalizedTargetLanguage = normalizeLanguageCode(targetLanguage);

  return storedLanguages.some(
    (language) => normalizeLanguageCode(language) === normalizedTargetLanguage
  );
}

function setStatus(message, tone = "normal") {
  if (!elements.statusMessage) {
    return;
  }

  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status${tone === "normal" ? "" : ` ${tone}`}`;
}

function clearStatus() {
  if (!elements.statusMessage) {
    return;
  }

  elements.statusMessage.textContent = "";
  elements.statusMessage.className = "status";
}

function formatCheckedAt(timestamp) {
  const timeLabel = new Date(timestamp).toLocaleTimeString(getUiLanguageTag(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  return t("apiStatusCheckedAt", [timeLabel]);
}
