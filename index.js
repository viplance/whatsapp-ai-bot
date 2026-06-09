import { config } from './src/config.js';
import { getLastScanTime } from './src/scanner.js';
import { startWhatsApp } from './src/whatsapp.js';

console.log('🚀 WhatsApp Summary Bot');
console.log(`   Модель:    ${config.model}`);
console.log(`   Интервал:  ${config.period}`);
console.log(`   Получатель: ${config.phone}`);
console.log(
  `   Последнее сканирование: ${getLastScanTime().toLocaleString('ru-RU')}\n`,
);

startWhatsApp();
