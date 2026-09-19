import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig(({ command, isPreview }) => ({
  // Относительные пути к ассетам — сайт работает из корня домена и из подпапки
  base: './',
  // HTTPS в dev нужен, чтобы камера работала при открытии с телефона по локальной сети.
  plugins: command === 'serve' && !isPreview ? [basicSsl()] : [],
}))
