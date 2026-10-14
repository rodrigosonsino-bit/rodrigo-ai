// T5a: npm run doctor. Só configuração declarada; não abre .env, notas, memórias nem docs/research/.
// Lê apenas variáveis de ambiente DESTE processo e a existência de três caminhos fixos do runtime de voz.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runDoctor, formatDoctorReport } = await import(
  pathToFileURL(path.join(root, 'dist', 'server', 'backend', 'doctor.js')).href
);
const report = runDoctor({ env: process.env, rootDir: root });
console.log(formatDoctorReport(report));
process.exit(report.summary.error > 0 ? 1 : 0);
