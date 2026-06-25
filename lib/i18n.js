// Localization system for Add to NotebookLM
// Supports English and Russian languages

const I18n = {
  // Current language
  currentLang: 'en',

  // Available languages
  languages: {
    en: 'English',
    ru: 'Русский'
  },

  // Translations cache for the active locale (key -> message)
  translations: {},

  // English translations cache — always loaded as a per-key fallback.
  // This prevents missing keys in the active locale from rendering as raw key names.
  translationsEn: {},

  // Initialize localization
  async init() {
    // Load saved language preference, falling back to the browser UI language.
    const storage = await chrome.storage.sync.get(['language']);
    this.currentLang = storage.language || this.detectBrowserLanguage();

    // Always load English first so the per-key fallback is available even if
    // the active locale fails to load (e.g., missing/corrupt messages.json).
    await this._loadLocale('en', /*targetEn*/ true);

    if (this.currentLang !== 'en') {
      try {
        await this._loadLocale(this.currentLang, /*targetEn*/ false);
      } catch (error) {
        console.error(`Failed to load translations for "${this.currentLang}":`, error);
        // Fall back to English entirely.
        this.currentLang = 'en';
        this.translations = { ...this.translationsEn };
      }
    } else {
      // Active locale IS English — mirror translations cache for consistency.
      this.translations = { ...this.translationsEn };
    }

    // Apply to page
    this.applyTranslations();

    return this.currentLang;
  },

  // Detect browser language.
  // Prefer chrome.i18n.getUILanguage() when available (extension context),
  // fall back to navigator.language (page context).
  detectBrowserLanguage() {
    let browserLang = '';
    if (typeof chrome !== 'undefined' && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
      try {
        browserLang = chrome.i18n.getUILanguage() || '';
      } catch (_) {
        browserLang = '';
      }
    }
    if (!browserLang) {
      browserLang = navigator.language || navigator.userLanguage || '';
    }
    if (browserLang.toLowerCase().startsWith('ru')) {
      return 'ru';
    }
    return 'en';
  },

  // Load a single locale's messages.json into the appropriate cache.
  // targetEn=true writes to translationsEn (English fallback); otherwise writes to translations.
  async _loadLocale(lang, targetEn) {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} loading _locales/${lang}/messages.json`);
    }
    const messages = await response.json();
    const flat = {};
    for (const [key, value] of Object.entries(messages)) {
      flat[key] = (value && typeof value === 'object' && 'message' in value) ? value.message : value;
    }
    if (targetEn) {
      this.translationsEn = flat;
    } else {
      this.translations = flat;
    }
  },

  // Get translated string with per-key English fallback.
  // Lookup order: active locale → English → raw key.
  get(key, substitutions = {}) {
    let text = this.translations[key];
    if (text === undefined || text === null || text === '') {
      text = this.translationsEn[key];
    }
    if (text === undefined || text === null || text === '') {
      // No translation in either locale — return the raw key (preserves prior behavior).
      text = key;
    }

    // Replace placeholders like $COUNT$, $CURRENT$, $TOTAL$
    for (const [placeholder, value] of Object.entries(substitutions)) {
      text = text.replace(new RegExp(`\\$${placeholder.toUpperCase()}\\$`, 'g'), value);
    }

    return text;
  },

  // Apply translations to elements with data-i18n attribute
  applyTranslations() {
    // Text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        el.textContent = this.get(key);
      }
    });

    // Placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        el.placeholder = this.get(key);
      }
    });

    // Titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        el.title = this.get(key);
      }
    });
  },

  // Set language and reload translations
  async setLanguage(lang) {
    if (!this.languages[lang]) {
      return false;
    }
    this.currentLang = lang;
    await chrome.storage.sync.set({ language: lang });

    // English is always kept loaded as the per-key fallback.
    if (lang === 'en') {
      this.translations = { ...this.translationsEn };
    } else {
      try {
        await this._loadLocale(lang, /*targetEn*/ false);
      } catch (error) {
        console.error(`Failed to load translations for "${lang}":`, error);
        // Fall back to English entirely.
        this.currentLang = 'en';
        this.translations = { ...this.translationsEn };
      }
    }
    this.applyTranslations();
    return true;
  },

  // Get current language
  getLanguage() {
    return this.currentLang;
  },

  // Get all available languages
  getAvailableLanguages() {
    return this.languages;
  }
};

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.I18n = I18n;
}
