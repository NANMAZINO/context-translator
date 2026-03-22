export const LANGUAGE_CODES = [
  "auto",
  "ko",
  "en",
  "ja",
  "zh-CN",
  "zh-TW",
  "es",
  "fr",
  "de",
  "vi"
];

const LANGUAGE_MESSAGE_KEYS = {
  auto: "languageAuto",
  ko: "languageKo",
  en: "languageEn",
  ja: "languageJa",
  "zh-CN": "languageZhCn",
  "zh-TW": "languageZhTw",
  es: "languageEs",
  fr: "languageFr",
  de: "languageDe",
  vi: "languageVi"
};

const NORMALIZED_LANGUAGE_MESSAGE_KEYS = new Map(
  Object.entries(LANGUAGE_MESSAGE_KEYS).map(([code, messageKey]) => [
    normalizeLanguageCode(code),
    messageKey
  ])
);

const TRANSLATION_LANGUAGE_NAMES = {
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

export function t(messageName, substitutions) {
  return chrome.i18n.getMessage(messageName, substitutions) || "";
}

export function getUiLanguageTag() {
  return chrome.i18n.getUILanguage?.() || "en";
}

export function getMessageLocale() {
  return normalizeLanguageCode(getUiLanguageTag()) === "ko" ? "ko" : "en";
}

export function createDefaultSettings() {
  return {
    apiKey: "",
    sourceLanguage: "auto",
    targetLanguage: getPreferredTargetLanguage(),
    showOriginalOnHover: true,
    autoTranslateLanguages: [],
    alwaysTranslateSites: []
  };
}

export function getPreferredTargetLanguage() {
  return getMessageLocale() === "ko" ? "ko" : "en";
}

export function getLanguageLabel(code) {
  if (!code || code === "und") {
    return "";
  }

  const exactMessageKey = LANGUAGE_MESSAGE_KEYS[code];

  if (exactMessageKey) {
    return t(exactMessageKey) || code;
  }

  const normalizedMessageKey = NORMALIZED_LANGUAGE_MESSAGE_KEYS.get(normalizeLanguageCode(code));
  return normalizedMessageKey ? t(normalizedMessageKey) || code : code;
}

export function getTranslationLanguageName(code) {
  return TRANSLATION_LANGUAGE_NAMES[code] ?? code;
}

export function normalizeLanguageCode(code) {
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
