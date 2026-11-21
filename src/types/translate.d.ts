// What src/translate.ts puts on window: the language the app is shown in (Settings → Language).

interface AppLangApi {
  /** The app's language as Google Translate names it: 'en', 'de', 'zh-CN', 'iw', … */
  readonly code: string;
  /**
   * The language to ask a service for: the app's language (without region: 'de', 'zh') when it is among the
   * ones the service offers, else `fallback` ('en' when left out).
   */
  pick(offered: readonly string[], fallback?: string): string;
  /**
   * A sentence that is said instead of shown (src/a11y.ts) in the app's language. It stays unanswered while
   * Google Translate can't be reached, so the caller should not wait long.
   */
  translate(text: string): Promise<string>;
}

declare var APP_LANG: AppLangApi;
