/**
 * i18n - Internationalization module
 * 国际化模块
 */
import { zhCN, type Language } from './zh-CN';
import { enUS } from './en-US';

// Available languages
const languages: Record<string, Language> = {
	'zh-CN': zhCN,
	'en-US': enUS,
	'zh': zhCN,  // alias for zh-CN
	'en': enUS,  // alias for en-US
};

// Default language
let currentLang: Language = zhCN;

/**
 * Get the current language code from Obsidian
 */
function detectLanguage(): string {
	// Try to get from Obsidian's locale
	if (typeof window !== 'undefined' && (window as any).obsidian?.locale) {
		return (window as any).obsidian.locale;
	}
	
	// Fallback to browser language
	if (typeof navigator !== 'undefined') {
		const browserLang = navigator.language || (navigator as any).userLanguage;
		return browserLang || 'en-US';
	}
	
	return 'en-US';
}

/**
 * Initialize i18n with the detected or specified language
 */
export function initI18n(langCode?: string): void {
	const code = langCode || detectLanguage();
	
	// Try exact match first
	if (languages[code]) {
		currentLang = languages[code];
		return;
	}
	
	// Try base language (e.g., 'zh' from 'zh-TW')
	const baseLang = code.split('-')[0];
	if (languages[baseLang]) {
		currentLang = languages[baseLang];
		return;
	}
	
	// Default to Chinese
	currentLang = zhCN;
}

/**
 * Get the current language pack
 */
export function t(): Language {
	return currentLang;
}

// Export language packs for direct access
export { zhCN, enUS, type Language };
