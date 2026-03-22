const DEFAULT_SETTINGS = {
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage: "ko",
  showOriginalOnHover: true,
  autoTranslateLanguages: [],
  alwaysTranslateSites: []
};
const API_STATUS_CACHE_STORAGE_KEY = "apiStatusCache";

const LANGUAGES = [
  { code: "auto", label: "자동" },
  { code: "ko", label: "한국어" },
  { code: "en", label: "영어" },
  { code: "ja", label: "일본어" },
  { code: "zh-CN", label: "중국어(간체)" },
  { code: "zh-TW", label: "중국어(번체)" },
  { code: "es", label: "스페인어" },
  { code: "fr", label: "프랑스어" },
  { code: "de", label: "독일어" },
  { code: "vi", label: "베트남어" }
];

const state = {
  activeTab: null,
  currentPageUrl: "",
  currentHost: "",
  isSupportedPage: false,
  pageLanguageHint: "",
  settings: { ...DEFAULT_SETTINGS },
  apiStatus: {
    message: "API 키가 없어요.",
    tone: "normal",
    checking: false,
    requestId: 0,
    checkedAtLabel: ""
  }
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  void initializePopup();
});

async function initializePopup() {
  cacheElements();
  bindRuntimeEvents();
  populateLanguageOptions();
  bindEvents();
  await loadState();
}

function cacheElements() {
  elements.sourceLanguage = document.getElementById("sourceLanguage");
  elements.targetLanguage = document.getElementById("targetLanguage");
  elements.swapLanguages = document.getElementById("swapLanguages");
  elements.alwaysTranslateLanguage = document.getElementById("alwaysTranslateLanguage");
  elements.alwaysTranslateLanguageLabel = document.getElementById("alwaysTranslateLanguageLabel");
  elements.alwaysTranslateSite = document.getElementById("alwaysTranslateSite");
  elements.showOriginalOnHover = document.getElementById("showOriginalOnHover");
  elements.siteHint = document.getElementById("siteHint");
  elements.apiKey = document.getElementById("apiKey");
  elements.saveApiKey = document.getElementById("saveApiKey");
  elements.clearApiKey = document.getElementById("clearApiKey");
  elements.apiServerStatus = document.getElementById("apiServerStatus");
  elements.checkApiStatus = document.getElementById("checkApiStatus");
  elements.statusMessage = document.getElementById("statusMessage");
  elements.translateButton = document.getElementById("translateButton");
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
  elements.sourceLanguage.innerHTML = LANGUAGES
    .map((language) => `<option value="${language.code}">${language.label}</option>`)
    .join("");

  elements.targetLanguage.innerHTML = LANGUAGES
    .filter((language) => language.code !== "auto")
    .map((language) => `<option value="${language.code}">${language.label}</option>`)
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
  elements.checkApiStatus.textContent = state.apiStatus.checking ? "확인 중..." : "확인";
}

function setApiServerStatus(message, tone = "normal", checkedAtLabel = "") {
  state.apiStatus.message = message;
  state.apiStatus.tone = tone;
  state.apiStatus.checkedAtLabel = checkedAtLabel;
  renderApiServerStatus();
}

function resetApiServerStatus(apiKey = state.settings.apiKey) {
  state.apiStatus.message = apiKey
    ? "저장된 키가 있어요. 확인 버튼으로 연결 상태를 확인해 주세요."
    : "API 키가 없어요.";
  state.apiStatus.tone = "normal";
  state.apiStatus.checking = false;
  state.apiStatus.checkedAtLabel = "";
}

function restoreApiServerStatus(apiKey, cache) {
  if (!apiKey) {
    resetApiServerStatus("");
    return;
  }

  if (!isStoredApiStatus(cache)) {
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
    setApiServerStatus("API 키가 없어요.", "normal");
    return;
  }

  if (apiKey !== state.settings.apiKey) {
    setApiServerStatus("변경된 키예요. 저장하거나 확인해 주세요.", "normal");
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
      ? `${detectedLabel} 항상 번역하기`
      : "감지된 언어 항상 번역하기";
    return;
  }

  const sourceLabel = getLanguageLabel(elements.sourceLanguage.value);
  elements.alwaysTranslateLanguageLabel.textContent = `${sourceLabel} 항상 번역하기`;
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
    elements.siteHint.textContent = "이 페이지에서는 사이트 자동 번역을 사용할 수 없어요.";
    return;
  }

  if (elements.sourceLanguage.value === "auto" && state.pageLanguageHint) {
    elements.siteHint.textContent = `현재 사이트 ${state.currentHost} · 감지 언어: ${getLanguageLabel(state.pageLanguageHint)}`;
    return;
  }

  elements.siteHint.textContent = `현재 사이트 ${state.currentHost}`;
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
    setStatus("이 페이지는 번역을 지원하지 않아요.", "error");
    return;
  }

  if (sourceLanguage === targetLanguage) {
    setStatus("원문 언어와 번역 언어를 다르게 선택해 주세요.", "error");
    return;
  }

  if (!hasApiKey) {
    setStatus("Gemini API 키를 입력해 주세요.", "normal");
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
    setStatus("Auto 원문일 때는 먼저 원문 언어를 직접 선택해 주세요.", "error");
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
    setStatus("현재 페이지 언어를 아직 감지하지 못해서 이 옵션을 저장할 수 없어요.", "error");
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
    setStatus("API 키를 저장했어요.", "success");
  } else {
    setStatus("API 키를 비웠어요.", "success");
  }

  await refreshApiServerStatus({ apiKey });
}

async function clearApiKey() {
  elements.apiKey.value = "";
  await saveSettings({ apiKey: "" });
  refreshTranslateButtonState();
  setStatus("API 키를 초기화했어요.", "success");
  setApiServerStatus("API 키가 없어요.", "normal");
}

async function refreshApiServerStatus(options = {}) {
  const { apiKey = elements.apiKey.value.trim(), quietOnEmpty = false } = options;

  if (!apiKey) {
    if (!quietOnEmpty) {
      setApiServerStatus("API 키가 없어요.", "normal");
    }
    return;
  }

  const requestId = state.apiStatus.requestId + 1;
  state.apiStatus.requestId = requestId;
  state.apiStatus.checking = true;
  renderApiServerStatus();
  setApiServerStatus("연결 확인 중...", "normal");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_API_STATUS",
      apiKey
    });

    if (requestId !== state.apiStatus.requestId || apiKey !== elements.apiKey.value.trim()) {
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error ?? "API 상태를 확인하지 못했어요.");
    }

    const checkedAt = Date.now();
    const latency = typeof response.latencyMs === "number" ? ` · ${response.latencyMs}ms` : "";
    const successMessage = `정상 연결 · ${response.modelName}${latency}`;
    setApiServerStatus(
      successMessage,
      "success",
      formatCheckedAt(checkedAt)
    );
    await persistApiServerStatus({
      message: successMessage,
      tone: "success",
      checkedAt
    });
  } catch (error) {
    if (requestId !== state.apiStatus.requestId || apiKey !== elements.apiKey.value.trim()) {
      return;
    }

    const checkedAt = Date.now();
    const errorMessage = error.message || "API 상태를 확인하지 못했어요.";
    setApiServerStatus(
      errorMessage,
      "error",
      formatCheckedAt(checkedAt)
    );
    await persistApiServerStatus({
      message: errorMessage,
      tone: "error",
      checkedAt
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
    setStatus("번역 대기 중이에요...", "normal");
    return;
  }

  if (stage === "translating") {
    setStatus(`번역 중... ${message.batchCount}번째 묶음을 처리하고 있어요.`, "normal");
    return;
  }

  if (stage === "continuing") {
    setStatus(
      `번역 중... ${message.batchCount}개 묶음을 마쳤고 다음 묶음을 이어서 처리하고 있어요.`,
      "normal"
    );
    return;
  }

  if (stage === "failed" || stage === "error") {
    setStatus(getFailedTranslationMessage(message), "error");
    return;
  }

  if (stage === "complete") {
    if ((message.batchCount ?? 1) > 1) {
      setStatus(
        `전체 번역을 완료했어요. ${message.batchCount}개 묶음을 순서대로 처리했어요.`,
        "success"
      );
      return;
    }

    setStatus("번역을 완료했어요.", "success");
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
    "마지막 번역이 실패했어요. 다시 시도해 주세요."
  );
}

async function handleTranslate() {
  if (!state.activeTab?.id) {
    setStatus("현재 탭을 찾지 못했어요.", "error");
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

  setStatus("번역을 시작할게요...", "normal");
  elements.translateButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_TRANSLATION",
      tabId: state.activeTab.id
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "번역에 실패했어요.");
    }

    updateTranslationProgressStatus({
      stage: "complete",
      batchCount: response.batchCount ?? 1
    });
  } catch (error) {
    setStatus(error.message || "번역에 실패했어요.", "error");
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
    cache.checkedAt > 0
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

function getLanguageLabel(code) {
  if (!code || code === "und") {
    return "";
  }

  const exactMatch = LANGUAGES.find((language) => language.code === code);

  if (exactMatch) {
    return exactMatch.label;
  }

  const normalizedCode = normalizeLanguageCode(code);

  return (
    LANGUAGES.find((language) => normalizeLanguageCode(language.code) === normalizedCode)?.label ??
    code
  );
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
  return `확인 ${new Date(timestamp).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })}`;
}
