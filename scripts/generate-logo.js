import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const svgPath = resolve(repoRoot, 'assets/logo.svg');
const pngPath = resolve(repoRoot, 'assets/logo.png');

const svg = await readFile(svgPath);
const png = await sharp(svg).resize(256, 256).png().toBuffer();
await writeFile(pngPath, png);

console.log(`wrote ${pngPath}`);
