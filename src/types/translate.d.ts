// What src/translate.ts puts on window: the language the app is shown in (Settings → Language).

interface AppLangApi {
  /** The app's language as Google Translate names it: 'en', 'de', 'zh-CN', 'iw', … */
  readonly code: string;
  /**
   * The language to ask a service for: the app's language (without region: 'de', 'zh') when it is among the
   * ones the service offers, else `fallback` ('en' when left out).
   */
  pick(offered: readonly string[], fallback?: string): string;
}

declare var APP_LANG: AppLangApi;
