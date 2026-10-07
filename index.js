import { config } from './src/config.js';
import { scanner, whatsapp } from './src/runtime.js';

// --since=YYYY-MM-DD  override the stored lastScanTime for this run
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
if (sinceArg) {
  const val = sinceArg.slice('--since='.length);
  const d = new Date(val);
  if (isNaN(d.getTime())) {
    console.error(`❌ Неверный формат даты для --since: "${val}" (ожидается YYYY-MM-DD или ISO)`);
    process.exit(1);
  }
  scanner.overrideLastScanTime(d);
  console.log(`⏪ lastScanTime сброшен на ${d.toLocaleString('ru-RU')}`);
}

console.log('🚀 WhatsApp Summary Bot');
console.log(`   Модель:    ${config.model}`);
console.log(`   Интервал:  ${config.period}`);
console.log(`   Тишина:    ${config.waitForNoActivity}`);
console.log(`   Получатели: ${config.phones.join(', ')}`);
console.log(
  `   Фильтры:   ${config.filters.length ? config.filters.join(', ') : '(нет — все чаты)'}`,
);
console.log(
  `   Последнее сканирование: ${scanner.getLastScanTime().toLocaleString('ru-RU')}\n`,
);

process.once('SIGINT', () => whatsapp.stop());
process.once('SIGTERM', () => whatsapp.stop());
await whatsapp.start();
