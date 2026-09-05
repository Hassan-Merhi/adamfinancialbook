import { useLanguage, type BookLanguage } from './i18n';

const OPTIONS: Array<{ id: BookLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'ar', label: 'العربية' },
];

export default function LanguageControl({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage } = useLanguage();
  return (
    <label className={`language-control${compact ? ' compact' : ''}`} data-no-translate>
      <span className="language-control-label">Language</span>
      <select value={language} onChange={(event) => setLanguage(event.target.value as BookLanguage)} aria-label="Language">
        {OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}
