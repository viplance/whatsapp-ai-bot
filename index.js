import { config } from './src/config.js';
import { getLastScanTime } from './src/scanner.js';
import { startWhatsApp } from './src/whatsapp.js';

console.log('🚀 WhatsApp Summary Bot');
console.log(`   Модель:    ${config.model}`);
console.log(`   Интервал:  ${config.period}`);
console.log(`   Тишина:    ${config.waitForNoActivity}`);
console.log(`   Получатели: ${config.phones.join(', ')}`);
console.log(
  `   Фильтры:   ${config.filters.length ? config.filters.join(', ') : '(нет — все чаты)'}`,
);
console.log(
  `   Последнее сканирование: ${getLastScanTime().toLocaleString('ru-RU')}\n`,
);

startWhatsApp();
