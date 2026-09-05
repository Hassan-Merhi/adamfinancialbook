import { useLanguage, type BookLanguage } from './i18n';
import { translateStatic } from './locales';

const OPTIONS: Array<{ id: BookLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'ar', label: 'العربية' },
];

export default function LanguageControl({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage } = useLanguage();
  const label = translateStatic(language, 'Language') ?? 'Language';

  const changeLanguage = (next: BookLanguage) => {
    // UI state changes first. Preference persistence is deliberately fire-and-forget
    // so a slow or offline connection can never freeze the language selector.
    setLanguage(next);
    void fetch('/api/preferences/language', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language: next }),
    }).catch(() => {
      // LanguageProvider has already persisted the same choice locally.
    });
  };

  return (
    <label className={`language-control${compact ? ' compact' : ''}`} data-no-translate>
      <span className="language-control-label">{label}</span>
      <select
        value={language}
        onChange={(event) => changeLanguage(event.target.value as BookLanguage)}
        aria-label={label}
      >
        {OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}
