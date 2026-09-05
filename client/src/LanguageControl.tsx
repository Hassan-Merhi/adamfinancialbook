import { useLanguage, type BookLanguage } from './i18n';

const OPTIONS: Array<{ id: BookLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'ar', label: 'العربية' },
];

export default function LanguageControl({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage } = useLanguage();

  const changeLanguage = (next: BookLanguage) => {
    // Change the UI immediately. Saving the preference is deliberately fire-and-forget
    // so a slow network can never freeze the language selector.
    setLanguage(next);
    void fetch('/api/preferences/language', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-book': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({ language: next }),
    }).catch(() => {
      // localStorage persistence in LanguageProvider still keeps this device usable.
    });
  };

  return (
    <label className={`language-control${compact ? ' compact' : ''}`} data-no-translate>
      <span className="language-control-label">Language</span>
      <select
        value={language}
        onChange={(event) => changeLanguage(event.target.value as BookLanguage)}
        aria-label="Language"
      >
        {OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}
