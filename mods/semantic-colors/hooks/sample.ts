// A reply covering every rule, drawn by `/semantic-colors sample` through the same planner a real reply goes through.
export const SAMPLE = [
  'result: PH-12 собран, PR #140 смержен',
  'needs input: какой бакет брать для KN-3?',
  'failed: деплой KM-7 на stage',
  '**Ждёт тебя:** ответ по KN-3',
  'Твоё решение: да или нет',
  '',
  '- красное: тесты упали, ошибка в парсере, error, failed, не работает, не взлетело, сломалось, проёб, бля',
  '- зелёное: теперь работает, взлетело, готово, починил, всё зелёное, passed ✅',
  '- пути: D:\\work\\game\\main.ts, ~/claude-code-kit/mods, hooks/register.tsx:42, colorize.ts:118',
  '- ссылки: https://code.claude.com/docs/en/plugins и [документация](https://example.com/docs)',
  '- числа: 350 МБ, 1.5 GB, 12 дн, 40%, 200 мс, 3 ч, 100 грн, $25, ₴80',
  '- код не трогаем: `error 350 МБ PH-1` и **жирное** с *курсивом*',
  '',
  '```bash',
  'echo "failed: error PH-1 350 МБ"  # блок кода — без раскраски',
  '```',
].join('\n')
